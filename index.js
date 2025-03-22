const { Telegraf } = require('telegraf');
const axios = require('axios');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
const fs = require('fs');
const path = require('path');

// Set FFmpeg path for fluent-ffmpeg
ffmpeg.setFfmpegPath(ffmpegInstaller.path);

// Get the bot token from environment variable
const botToken = process.env.TOKEN;

if (!botToken) {
  console.error('Bot token not configured. Please set the TOKEN environment variable.');
  process.exit(1);
}

const bot = new Telegraf(botToken);

// Introduction message on /start
bot.start((ctx) => {
  ctx.reply(`
🎥 *Video Compressor Bot* 🎥
Powered by @KaIi_Linux_BOT

Send me a video, and I’ll compress it for you while keeping decent quality! 🚀

⚠️ Note: Videos must be under 50 MB (Telegram limit), and the compressed video will also be under 50 MB.
  `, { parse_mode: 'Markdown' });
});

// Function to download a video from Telegram
async function downloadVideo(fileId, ctx) {
  try {
    const file = await ctx.telegram.getFile(fileId);
    const fileUrl = `https://api.telegram.org/file/bot${botToken}/${file.file_path}`;
    const filePath = path.join(__dirname, `input-${Date.now()}.mp4`);

    const response = await axios({
      url: fileUrl,
      method: 'GET',
      responseType: 'stream',
      timeout: 15000 // 15-second timeout for download
    });

    const writer = fs.createWriteStream(filePath);
    response.data.pipe(writer);

    return new Promise((resolve, reject) => {
      writer.on('finish', () => resolve(filePath));
      writer.on('error', (err) => reject(err));
    });
  } catch (error) {
    throw new Error('Failed to download video: ' + error.message);
  }
}

// Function to compress the video using FFmpeg
async function compressVideo(inputPath) {
  const outputPath = path.join(__dirname, `output-${Date.now()}.mp4`);

  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .videoCodec('libx264') // Use H.264 codec for efficient compression
      .videoBitrate('1M') // Set video bitrate to 1 Mbps (adjustable)
      .size('1280x720') // Scale to 720p (adjustable)
      .fps(24) // Reduce frame rate to 24 fps
      .audioCodec('aac') // Use AAC for audio
      .audioBitrate('128k') // Set audio bitrate to 128 kbps
      .on('end', () => {
        // Check file size after compression
        const stats = fs.statSync(outputPath);
        if (stats.size > 50 * 1024 * 1024) {
          fs.unlinkSync(outputPath);
          reject(new Error('Compressed video is still too large (>50 MB).'));
        } else {
          resolve(outputPath);
        }
      })
      .on('error', (err) => {
        reject(new Error('Failed to compress video: ' + err.message));
      })
      .save(outputPath);
  });
}

// Handle incoming videos (non-blocking)
bot.on('video', async (ctx) => {
  const fileId = ctx.message.video.file_id;
  let inputPath = null;
  let outputPath = null;

  // Send "Processing..." message immediately
  ctx.reply('Processing your video... ⏳').catch((err) => console.error('Failed to send processing message:', err));

  // Process the video compression in a non-blocking way
  setImmediate(async () => {
    try {
      // Step 1: Download the video
      ctx.reply('Downloading video... 📥');
      inputPath = await downloadVideo(fileId, ctx);

      // Check input file size
      const inputStats = fs.statSync(inputPath);
      if (inputStats.size > 50 * 1024 * 1024) {
        throw new Error('Input video is too large (>50 MB). Telegram limits uploads to 50 MB.');
      }

      // Step 2: Compress the video
      ctx.reply('Compressing video... 🎬');
      outputPath = await compressVideo(inputPath);

      // Step 3: Send the compressed video
      ctx.reply('Sending compressed video... 🚀');
      await ctx.replyWithVideo({ source: outputPath });

      // Clean up
      fs.unlinkSync(inputPath);
      fs.unlinkSync(outputPath);
    } catch (error) {
      // Clean up files if they exist
      if (inputPath && fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
      if (outputPath && fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
      ctx.reply('❌ Error: ' + error.message);
    }
  });
});

// Export the handler for Vercel
module.exports = async (req, res) => {
  try {
    if (req.method === 'POST') {
      await bot.handleUpdate(req.body);
      res.status(200).json({ ok: true });
    } else {
      res.status(200).send('Bot is running.');
    }
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
};
