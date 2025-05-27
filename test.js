const youtubedl = require('youtube-dl-exec');
const path = require('path');
const { exec } = require('child_process');
const fs = require('fs');

const url = 'https://youtu.be/ER9SspLe4Hg?si=3i-sRRqywj8XSU4T';

(async () => {
  try {
    const info = await youtubedl(url, {
      dumpSingleJson: true,
      noWarnings: true,
      noCheckCertificates: true,
      preferFreeFormats: true,
    });

    console.log(`Video title: ${info.title}`);

    // Log all formats for debugging
    console.log('\nAvailable formats:');
    info.formats.forEach(f => {
      const size = f.filesize || f.filesize_approx || 0;
      console.log(`ID: ${f.format_id} | ext: ${f.ext} | size: ${(size / (1024*1024)).toFixed(2)} MB | audio: ${f.acodec} | video: ${f.vcodec} | res: ${f.height || 'N/A'}`);
    });

    // Try to find combined 720p (audio+video)
    let combined720p = info.formats.find(f =>
      (f.ext === 'mp4' || f.ext === 'webm') &&
      f.height === 720 &&
      f.acodec !== 'none' &&
      f.vcodec !== 'none'
    );

    // If combined 720p found, download it directly
    if (combined720p) {
      console.log('\nCombined 720p format found:');
      console.log(`  Format ID: ${combined720p.format_id}`);
      const safeTitle = info.title.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').slice(0, 100);
      const outputFile = path.resolve(__dirname, `${safeTitle}_${combined720p.format_id}.${combined720p.ext}`);
      console.log(`Downloading video to: ${outputFile}`);
      await youtubedl(url, {
        format: combined720p.format_id,
        output: outputFile,
      });
      console.log('Download complete.');
      return;
    }

    // No combined 720p found, download video-only 720p + best audio, then merge
    console.log('\nNo combined 720p format found, downloading video-only + audio separately...');

    // Find video-only 720p formats (no audio codec)
    const videoOnly720p = info.formats.find(f =>
      (f.ext === 'mp4' || f.ext === 'webm') &&
      f.height === 720 &&
      f.acodec === 'none' &&
      f.vcodec !== 'none'
    );

    if (!videoOnly720p) {
      console.log('No video-only 720p format found.');
      return;
    }

    // Find best audio-only format (highest bitrate)
    const audioFormats = info.formats.filter(f =>
      f.acodec !== 'none' &&
      f.vcodec === 'none' &&
      (f.ext === 'mp4' || f.ext === 'webm' || f.ext === 'm4a')
    ).sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));

    if (audioFormats.length === 0) {
      console.log('No audio-only formats found.');
      return;
    }

    const bestAudio = audioFormats[0];

    const safeTitle = info.title.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').slice(0, 100);
    const videoPath = path.resolve(__dirname, `${safeTitle}_video.${videoOnly720p.ext}`);
    const audioPath = path.resolve(__dirname, `${safeTitle}_audio.${bestAudio.ext}`);
    const outputPath = path.resolve(__dirname, `${safeTitle}_720p_merged.mp4`);

    console.log(`Downloading video-only 720p format (ID: ${videoOnly720p.format_id}) to: ${videoPath}`);
    await youtubedl(url, { format: videoOnly720p.format_id, output: videoPath });

    console.log(`Downloading audio-only format (ID: ${bestAudio.format_id}) to: ${audioPath}`);
    await youtubedl(url, { format: bestAudio.format_id, output: audioPath });

    console.log('Merging video and audio with ffmpeg...');

    // Build ffmpeg merge command
    const ffmpegCmd = `ffmpeg -y -i "${videoPath}" -i "${audioPath}" -c:v copy -c:a aac "${outputPath}"`;

    exec(ffmpegCmd, (error, stdout, stderr) => {
      if (error) {
        console.error('ffmpeg merge error:', error);
        return;
      }
      console.log('Merging complete. Output file:', outputPath);

      // Optional: delete separate video/audio files after merge
      try {
        fs.unlinkSync(videoPath);
        fs.unlinkSync(audioPath);
        console.log('Temporary files deleted.');
      } catch (e) {
        console.error('Error deleting temporary files:', e);
      }
    });

  } catch (err) {
    console.error('Error fetching video info or downloading:', err);
  }
})();
