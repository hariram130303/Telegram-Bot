require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const path = require('path');
const fs = require('fs/promises'); // Use promises API for async/await
const fsSync = require('fs'); // For sync methods when needed
const os = require('os');
const sanitize = require('sanitize-filename');
const youtubedl = require('youtube-dl-exec');
const { exec } = require('child_process');
const archiver = require('archiver');

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });

// Max Telegram upload size: 200MB
const MAX_SIZE = 200 * 1024 * 1024;
// Limit playlist videos to avoid overload
const MAX_PLAYLIST_VIDEOS = 10;

bot.onText(/\/start/, msg => {
  bot.sendMessage(msg.chat.id, '📺 Send a YouTube video or playlist link and I\'ll download it for you (Max 200MB per file).');
});

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const url = msg.text;

  if (!url || url.startsWith('/')) return;

  if (!/^https?:\/\/(www\.)?(youtube\.com|youtu\.be)/.test(url)) {
    return bot.sendMessage(chatId, '❌ Please send a valid YouTube or playlist URL.');
  }

  try {
    await bot.sendMessage(chatId, '🔍 Fetching video(s) info...');

    const info = await youtubedl(url, {
      dumpSingleJson: true,
      flatPlaylist: false,
      noWarnings: true,
      noCheckCertificates: true,
      preferFreeFormats: true,
    });

    if (info.entries && info.entries.length > 1) {
      // Playlist
      await handlePlaylist(chatId, info);
    } else {
      // Single video
      await handleSingleVideo(chatId, info, url);
    }
  } catch (err) {
    console.error(err);
    bot.sendMessage(chatId, '❌ Failed to download video or playlist.');
  }
});

async function handleSingleVideo(chatId, info, url) {
  const safeTitle = sanitize(info.title || 'video').slice(0, 100);
  await bot.sendMessage(chatId, `🎞️ Processing video: ${safeTitle}`);

  // Log available formats for debug
  console.log(`Formats for "${safeTitle}":`);
  info.formats.forEach(f => {
    const size = f.filesize || f.filesize_approx || 0;
    console.log(`ID: ${f.format_id} | ext: ${f.ext} | size: ${(size / (1024*1024)).toFixed(2)} MB | audio: ${f.acodec} | video: ${f.vcodec} | res: ${f.height || 'N/A'}`);
  });

  // Try combined 720p under size limit
  let combined = info.formats.find(f =>
    (f.ext === 'mp4' || f.ext === 'webm') &&
    f.height === 720 &&
    f.acodec !== 'none' &&
    f.vcodec !== 'none' &&
    ((f.filesize || f.filesize_approx) || 0) <= MAX_SIZE
  );

  if (combined) {
    const outputPath = path.resolve(__dirname, `${safeTitle}_${combined.format_id}.${combined.ext}`);
    await bot.sendMessage(chatId, `📥 Downloading combined 720p format (${combined.format_id})...`);

    await youtubedl(url, {
      format: combined.format_id,
      output: outputPath,
    });

    // Check file size before sending
    try {
      const stats = await fs.stat(outputPath);
      if (stats.size > MAX_SIZE) {
        await bot.sendMessage(chatId, '⚠️ Downloaded video exceeds 200MB, cannot send via Telegram.');
      } else {
        await bot.sendVideo(chatId, outputPath);
      }
    } catch (err) {
      console.error('File stat error:', err);
      await bot.sendMessage(chatId, '❌ Error reading downloaded file.');
    }

    cleanupFile(outputPath);
    return;
  }

  // fallback: video-only + best audio and merge
  await bot.sendMessage(chatId, '⚠️ No combined 720p under size limit, downloading video-only + audio separately and merging...');

  // video-only 720p under size limit
  const videoOnly = info.formats.find(f =>
    (f.ext === 'mp4' || f.ext === 'webm') &&
    f.height === 720 &&
    f.acodec === 'none' &&
    f.vcodec !== 'none' &&
    ((f.filesize || f.filesize_approx) || 0) <= MAX_SIZE
  );

  if (!videoOnly) {
    return bot.sendMessage(chatId, '❌ No suitable video-only 720p format under size limit found.');
  }

  // Best audio-only format under size limit
  const audioCandidates = info.formats.filter(f =>
    f.acodec !== 'none' &&
    f.vcodec === 'none' &&
    (f.ext === 'mp4' || f.ext === 'webm' || f.ext === 'm4a') &&
    ((f.filesize || f.filesize_approx) || 0) <= MAX_SIZE
  ).sort((a, b) => (b.abr || b.bitrate || 0) - (a.abr || a.bitrate || 0));

  if (audioCandidates.length === 0) {
    return bot.sendMessage(chatId, '❌ No suitable audio-only format under size limit found.');
  }

  const bestAudio = audioCandidates[0];

  const videoPath = path.resolve(__dirname, `${safeTitle}_video.${videoOnly.ext}`);
  const audioPath = path.resolve(__dirname, `${safeTitle}_audio.${bestAudio.ext}`);
  const outputPath = path.resolve(__dirname, `${safeTitle}_720p_merged.mp4`);

  try {
    await bot.sendMessage(chatId, `📥 Downloading video-only (ID: ${videoOnly.format_id})...`);
    await youtubedl(url, { format: videoOnly.format_id, output: videoPath });

    await bot.sendMessage(chatId, `📥 Downloading audio-only (ID: ${bestAudio.format_id})...`);
    await youtubedl(url, { format: bestAudio.format_id, output: audioPath });

    await bot.sendMessage(chatId, '⚙️ Merging video and audio...');
    await ffmpegMerge(videoPath, audioPath, outputPath);

    // Check size after merge
    const stats = await fs.stat(outputPath);
    if (stats.size > MAX_SIZE) {
      await bot.sendMessage(chatId, '⚠️ Merged video exceeds 200MB, cannot send via Telegram.');
    } else {
      await bot.sendVideo(chatId, outputPath);
    }
  } catch (err) {
    console.error('Error downloading or merging:', err);
    await bot.sendMessage(chatId, '❌ Error during download or merge.');
  } finally {
    await cleanupFile(videoPath);
    await cleanupFile(audioPath);
    await cleanupFile(outputPath);
  }
}

async function handlePlaylist(chatId, info) {
  const safeTitle = sanitize(info.title || 'playlist').slice(0, 100);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ytplaylist-'));
  const zipPath = path.resolve(__dirname, `${safeTitle}.zip`);

  await bot.sendMessage(chatId, `📥 Downloading playlist: ${safeTitle} (${info.entries.length} videos)...`);

  const downloadedFiles = [];

  // Limit number of videos processed
  const entries = info.entries.slice(0, MAX_PLAYLIST_VIDEOS);

  for (const video of entries) {
    try {
      // video.url can be an id string; form full URL
      const videoUrl = video.url && video.url.startsWith('http') ? video.url : `https://www.youtube.com/watch?v=${video.id || video.url}`;

      const videoInfo = await youtubedl(videoUrl, {
        dumpSingleJson: true,
        noWarnings: true,
        noCheckCertificates: true,
        preferFreeFormats: true,
      });

      const vTitle = sanitize(videoInfo.title || 'video').slice(0, 100);
      console.log(`Processing playlist video: ${vTitle}`);

      // Try combined 720p
      let combined = videoInfo.formats.find(f =>
        (f.ext === 'mp4' || f.ext === 'webm') &&
        f.height === 720 &&
        f.acodec !== 'none' &&
        f.vcodec !== 'none' &&
        ((f.filesize || f.filesize_approx) || 0) <= MAX_SIZE
      );

      let outputPath;

      if (combined) {
        outputPath = path.join(tempDir, `${vTitle}_${combined.format_id}.${combined.ext}`);
        console.log(`Downloading combined 720p for playlist video: ${vTitle}`);
        await youtubedl(videoUrl, { format: combined.format_id, output: outputPath });
      } else {
        // fallback: video+audio separate and merge
        console.log(`No combined 720p for "${vTitle}", downloading separate video/audio...`);

        const videoOnly = videoInfo.formats.find(f =>
          (f.ext === 'mp4' || f.ext === 'webm') &&
          f.height === 720 &&
          f.acodec === 'none' &&
          f.vcodec !== 'none' &&
          ((f.filesize || f.filesize_approx) || 0) <= MAX_SIZE
        );

        if (!videoOnly) {
          console.warn(`Skipping "${vTitle}": no suitable video-only 720p under size limit.`);
          continue;
        }

        const audioCandidates = videoInfo.formats.filter(f =>
          f.acodec !== 'none' &&
          f.vcodec === 'none' &&
          (f.ext === 'mp4' || f.ext === 'webm' || f.ext === 'm4a') &&
          ((f.filesize || f.filesize_approx) || 0) <= MAX_SIZE
        ).sort((a, b) => (b.abr || b.bitrate || 0) - (a.abr || a.bitrate || 0));

        if (audioCandidates.length === 0) {
          console.warn(`Skipping "${vTitle}": no suitable audio-only format under size limit.`);
          continue;
        }

        const bestAudio = audioCandidates[0];

        const videoPath = path.join(tempDir, `${vTitle}_video.${videoOnly.ext}`);
        const audioPath = path.join(tempDir, `${vTitle}_audio.${bestAudio.ext}`);
        outputPath = path.join(tempDir, `${vTitle}_720p_merged.mp4`);

        await youtubedl(videoUrl, { format: videoOnly.format_id, output: videoPath });
        await youtubedl(videoUrl, { format: bestAudio.format_id, output: audioPath });

        await ffmpegMerge(videoPath, audioPath, outputPath);

        // Cleanup separate files
        await cleanupFile(videoPath);
        await cleanupFile(audioPath);
      }

      downloadedFiles.push({ path: outputPath, name: path.basename(outputPath) });
    } catch (err) {
      console.error('Error downloading playlist video:', err);
    }
  }

  if (downloadedFiles.length === 0) {
    await cleanupTemp(downloadedFiles, tempDir, zipPath);
    return bot.sendMessage(chatId, `❌ No videos could be downloaded under 200MB or within limit of ${MAX_PLAYLIST_VIDEOS} videos.`);
  }

  try {
    await zipFiles(downloadedFiles, zipPath);

    const zipStats = await fs.stat(zipPath);
    if (zipStats.size > MAX_SIZE) {
      await bot.sendMessage(chatId, '⚠️ Zipped file exceeds 200MB. Cannot send via Telegram.');
    } else {
      await bot.sendDocument(chatId, zipPath);
    }
  } catch (err) {
    console.error('Error creating or sending zip:', err);
    await bot.sendMessage(chatId, '❌ Failed to create or send zipped playlist.');
  } finally {
    await cleanupTemp(downloadedFiles, tempDir, zipPath);
  }
}

function ffmpegMerge(videoPath, audioPath, outputPath) {
  return new Promise((resolve, reject) => {
    const cmd = `ffmpeg -y -i "${videoPath}" -i "${audioPath}" -c:v copy -c:a aac "${outputPath}"`;

    exec(cmd, (error, stdout, stderr) => {
      if (error) {
        console.error('ffmpeg merge error:', error);
        reject(error);
      } else {
        console.log('Merge complete:', outputPath);
        resolve();
      }
    });
  });
}

function zipFiles(files, zipPath) {
  return new Promise((resolve, reject) => {
    const output = fsSync.createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 9 } });

    output.on('close', () => {
      console.log(`Zip created: ${zipPath} (${archive.pointer()} bytes)`);
      resolve();
    });

    archive.on('error', err => reject(err));

    archive.pipe(output);

    for (const file of files) {
      archive.file(file.path, { name: file.name });
    }

    archive.finalize();
  });
}

async function cleanupFile(filePath) {
  try {
    await fs.unlink(filePath);
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('Failed to delete file:', filePath, err);
  }
}

async function cleanupTemp(files, tempDir, zipPath) {
  // Cleanup all files first
  await Promise.all(files.map(f => cleanupFile(f.path)));

  try {
    await fs.rmdir(tempDir, { recursive: true });
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('Failed to remove temp dir:', tempDir, err);
  }

  await cleanupFile(zipPath);
}
