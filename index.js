const { Telegraf } = require('telegraf');
const axios = require('axios');

// Get the bot token from environment variable
const botToken = process.env.TOKEN;

if (!botToken) {
  console.error('Bot token not configured. Please set the TOKEN environment variable.');
  process.exit(1);
}

const bot = new Telegraf(botToken);

// API endpoint
const API_URL = 'https://ar-api-08uk.onrender.com/uphd';

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
bot.start(async (ctx) => {
  await ctx.reply(`
🎨 *Wallpaper Download Bot* 🎨
Powered by @KaIi_Linux_BOT

Send me a query (e.g., "nature", "space", "anime"), and I’ll fetch high-quality wallpapers for you! 🚀

I’ll send each wallpaper as a photo with its URL and details.
  `, { parse_mode: 'Markdown' }).catch((err) => {
    console.error('Failed to send /start message:', err.message);
  });
});

// Function to fetch wallpapers from the API with retry logic
async function fetchWallpapers(query, maxRetries = 3) {
  let attempt = 0;
  while (attempt < maxRetries) {
    try {
      const response = await axios.get(API_URL, {
        params: { query },
        timeout: 10000 // 10-second timeout for API request
      });
      return response.data;
    } catch (error) {
      attempt++;
      if (attempt === maxRetries) {
        throw new Error('Failed to fetch wallpapers after retries: ' + error.message);
      }
      console.error(`Fetch wallpapers attempt ${attempt} failed: ${error.message}. Retrying...`);
      await new Promise((resolve) => setTimeout(resolve, 2000)); // Wait 2 seconds before retrying
    }
  }
}

// Function to send a photo with retry logic
async function sendPhotoWithRetry(ctx, photoUrl, caption, maxRetries = 3) {
  let attempt = 0;
  while (attempt < maxRetries) {
    try {
      // Truncate caption if it exceeds Telegram's 1024-character limit
      if (caption.length > 1024) {
        caption = caption.substring(0, 1020) + '...';
      }
      await ctx.replyWithPhoto(photoUrl, { caption, parse_mode: 'Markdown' });
      return;
    } catch (error) {
      attempt++;
      if (attempt === maxRetries) {
        throw new Error('Failed to send photo after retries: ' + error.message);
      }
      console.error(`Send photo attempt ${attempt} failed: ${error.message}. Retrying...`);
      await new Promise((resolve) => setTimeout(resolve, 2000)); // Wait 2 seconds before retrying
    }
  }
}

// Function to send a message with retry logic
async function sendMessageWithRetry(ctx, message, maxRetries = 3) {
  let attempt = 0;
  while (attempt < maxRetries) {
    try {
      await ctx.reply(message, { parse_mode: 'Markdown' });
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

// Handle incoming text messages (non-blocking)
bot.on('text', async (ctx) => {
  const chatId = ctx.chat.id;
  const query = ctx.message.text.trim();

  // Check rate limit
  try {
    checkRateLimit(chatId);
  } catch (error) {
    await sendMessageWithRetry(ctx, `❌ ${error.message}`);
    return;
  }

  // Send "Fetching..." message immediately
  await sendMessageWithRetry(ctx, 'Fetching wallpapers... ⏳');

  // Process the API request in a non-blocking way
  setImmediate(async () => {
    try {
      // Fetch wallpapers from the API
      const response = await fetchWallpapers(query);

      // Check if the API response is valid
      if (response.status !== 200 || response.successful !== 'success' || !Array.isArray(response.data)) {
        throw new Error('Invalid API response. Please try a different query.');
      }

      const wallpapers = response.data;

      if (wallpapers.length === 0) {
        await sendMessageWithRetry(ctx, '❌ No wallpapers found for your query. Try something else (e.g., "nature", "space", "anime").');
        return;
      }

      // Send each wallpaper as a photo with its URL and details
      for (const wallpaper of wallpapers) {
        try {
          const caption = `
*${wallpaper.title}*  
Resolution: ${wallpaper.resolution}  
[Image URL](${wallpaper.imageUrl})  
[View Full Details](${wallpaper.link})
          `;
          await sendPhotoWithRetry(ctx, wallpaper.imageUrl, caption);
          // Add a small delay to avoid hitting Telegram's rate limits
          await new Promise((resolve) => setTimeout(resolve, 1000));
        } catch (error) {
          await sendMessageWithRetry(ctx, `❌ Failed to send a wallpaper: ${error.message}`);
        }
      }

      // Send the Join link if available
      if (response.Join) {
        await sendMessageWithRetry(ctx, `Join the community: [Ashlynn Repository](${response.Join})`);
      }
    } catch (error) {
      console.error('Error:', error.message);
      await sendMessageWithRetry(ctx, `❌ Sorry, I couldn’t fetch wallpapers. Error: ${error.message}\nTry a different query or check back later.`);
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
