const { Telegraf } = require('telegraf');
const https = require('https');
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

// Simple rate limiter to prevent hitting Telegram API limits
const rateLimit = new Map();
const RATE_LIMIT_REQUESTS = 30; // Telegram's limit: ~30 requests per second
const RATE_LIMIT_WINDOW = 1000; // 1 second window

function checkRateLimit(chatId) {
  const now = Date.now();
  const userRequests = rateLimit.get(chatId) || { count: 0, timestamp: now };

  if (now - userRequests.timestamp > RATE_LIMIT_WINDOW) {
    userRequests.count = 0;
    userRequests.timestamp = now;
  }

  userRequests.count++;
  rateLimit.set(chatId, userRequests);

  if (userRequests.count > RATE_LIMIT_REQUESTS) {
    throw new Error('Rate limit exceeded. Please wait a moment and try again.');
  }
}

// Introduction message on /start
bot.start((ctx) => {
  ctx.reply(`
🎥 *Video Compressor Bot* 🎥
Powered by @KaIi_Linux_BOT

Send me a video, and I’ll compress it for you with balanced quality! 🚀

⚠️ Note: Videos must be under 20 MB and 20 seconds (Vercel limits). Compressed video will also be under 20 MB.
  `, { parse_mode: 'Markdown' }).catch((err) => {
    console.error('Failed to send /start message:', err.message);
  });
});

// Function to get file info with retry logic
async function getFileWithRetry(telegram, fileId, maxRetries = 3) {
  let attempt = 0;
  while (attempt < maxRetries) {
    try {
      return await telegram.getFile(fileId, { timeout: 10000 }); // 10-second timeout for getFile
    } catch (error) {
      attempt++;
      if (attempt === maxRetries) {
        throw new Error('Failed to get file info after retries: ' + error.message);
      }
      console.error(`getFile attempt ${attempt} failed: ${error.message}. Retrying...`);
      await new Promise((resolve) => setTimeout(resolve, 2000)); // Wait 2 seconds before retrying
    }
  }
}

// Function to download a video from Telegram using https with retry logic
async function downloadVideo(fileId, ctx) {
  const maxRetries = 3;
  let attempt = 0;

  // Check rate limit
  checkRateLimit(ctx.chat.id);

  // Get file info
  const file = await getFileWithRetry(ctx.telegram, fileId);

  // Check file size before downloading
  if (file.file_size > 20 * 1024 * 1024) {
    throw new Error('Video is too large (>20 MB). Vercel limits downloads to 20 MB for faster processing.');
  }

  const fileUrl = `https://api.telegram.org/file/bot${botToken}/${file.file_path}`;
  const filePath = path.join(__dirname, `input-${Date.now()}.mp4`);

  while (attempt < maxRetries) {
    try {
      return await new Promise((resolve, reject) => {
        const fileStream = fs.createWriteStream(filePath);
        const request = https.get(fileUrl, { timeout: 30000 }, (response) => {
          response.pipe(fileStream);
          fileStream.on('finish', () => {
            fileStream.close();
            resolve(filePath);
          });
        });

        request.on('error', (err) => {
          fileStream.close();
          fs.unlinkSync(filePath);
          reject(err);
        });

        fileStream.on('error', (err) => {
          fileStream.close();
          fs.unlinkSync(filePath);
          reject(err);
        });

        // Timeout for the request
        request.setTimeout(30000, () => {
          request.destroy();
          fileStream.close();
          fs.unlinkSync(filePath);
          reject(new Error('Download timeout of 30 seconds exceeded'));
        });
      });
    } catch (error) {
      attempt++;
      if (attempt === maxRetries) {
        throw new Error('Failed to download video after retries: ' + error.message);
      }
      console.error(`Download attempt ${attempt} failed: ${error.message}. Retrying...`);
      await new Promise((resolve) => setTimeout(resolve, 2000)); // Wait 2 seconds before retrying
    }
  }
}

// Function to compress the video using FFmpeg with balanced settings
async function compressVideo(inputPath) {
  const outputPath = path.join(__dirname, `output-${Date.now()}.mp4`);

  return new Promise((resolve, reject) => {
    const ffmpegProcess = ffmpeg(inputPath)
      .videoCodec('libx264')
      .videoBitrate('1M') // 1 Mbps bitrate for better quality
      .size('960x540') // Scale to 540p
      .fps(24) // 24 fps
      .audioCodec('aac')
      .audioBitrate('128k') // 128 kbps audio
      .addOption('-preset', 'faster') // Faster preset for quicker compression
      .addOption('-crf', '23') // Lower CRF for better quality
      .on('end', () => {
        // Check file size after compression
        const stats = fs.statSync(outputPath);
        if (stats.size > 20 * 1024 * 1024) {
          fs.unlinkSync(outputPath);
          reject(new Error('Compressed video is still too large (>20 MB).'));
        } else {
          resolve(outputPath);
        }
      })
      .on('error', (err) => {
        reject(new Error('Failed to compress video: ' + err.message));
      })
      .save(outputPath);

    // Timeout for FFmpeg (30 seconds)
    setTimeout(() => {
      ffmpegProcess.kill('SIGKILL');
      reject(new Error('Video compression timed out after 30 seconds.'));
    }, 30000);
  });
}

// Function to send a message with retry logic
async function sendMessageWithRetry(ctx, message, maxRetries = 3) {
  let attempt = 0;
  while (attempt < maxRetries) {
    try {
      await ctx.reply(message);
      return;
    } catch (error) {
      attempt++;
      if (attempt === maxRetries) {
        console.error(`Failed to send message after ${maxRetries} retries: ${error.message}`);
        return;
      }
      console.error(`Send message attempt ${attempt} failed: ${error.message}. Retrying...`);
      await new Promise((resolve) => setTimeout(resolve, 2000)); // Wait 2 seconds before retrying
    }
  }
}

// Function to send a video with retry logic
async function sendVideoWithRetry(ctx, videoPath, maxRetries = 3) {
  let attempt = 0;
  while (attempt < maxRetries) {
    try {
      // Show "uploading video" status to the user
      await ctx.telegram.sendChatAction(ctx.chat.id, 'upload_video');
      await ctx.replyWithVideo({ source: videoPath });
      return;
    } catch (error) {
      attempt++;
      if (attempt === maxRetries) {
        throw new Error('Failed to send video after retries: ' + error.message);
      }
      console.error(`Send video attempt ${attempt} failed: ${error.message}. Retrying...`);
      await new Promise((resolve) => setTimeout(resolve, 2000)); // Wait 2 seconds before retrying
    }
  }
}

// Handle incoming videos (non-blocking)
bot.on('video', async (ctx) => {
  const fileId = ctx.message.video.file_id;
  const duration = ctx.message.video.duration; // Duration in seconds
  let inputPath = null;
  let outputPath = null;

  // Check video duration (Vercel limitation)
  if (duration > 20) {
    await sendMessageWithRetry(ctx, '❌ Video is too long (>20 seconds). Please send a shorter video.');
    return;
  }

  // Send "Processing..." message immediately
  await sendMessageWithRetry(ctx, 'Processing your video... ⏳');

  // Process the video compression in a non-blocking way
  setImmediate(async () => {
    try {
      // Step 1: Download the video
      inputPath = await downloadVideo(fileId, ctx);

      // Step 2: Compress the video
      await sendMessageWithRetry(ctx, 'Compressing video... 🎬');
      outputPath = await compressVideo(inputPath);

      // Step 3: Send the compressed video
      await sendMessageWithRetry(ctx, 'Sending compressed video... 🚀');
      await sendVideoWithRetry(ctx, outputPath);

      // Clean up
      fs.unlinkSync(inputPath);
      fs.unlinkSync(outputPath);
    } catch (error) {
      // Clean up files if they exist
      if (inputPath && fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
      if (outputPath && fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
      await sendMessageWithRetry(ctx, '❌ Error: ' + error.message);
    }
  });
});

// Handle unhandled rejections to prevent crashes
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
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
    console.error('Error in Vercel handler:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
};
