import localtunnel from 'localtunnel';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const urlFile = path.resolve(__dirname, '../public_url.txt');

const SUBDOMAINS = ['cardiox-ai-live', 'cardiox-telemetry', 'cardiox-health-monitoring'];

async function launchTunnel(index = 0) {
  const chosenSubdomain = SUBDOMAINS[index % SUBDOMAINS.length];
  console.log(`[Tunnel Manager] Launching tunnel on port 5000 with subdomain: ${chosenSubdomain}...`);

  try {
    const tunnel = await localtunnel({
      port: 5000,
      subdomain: chosenSubdomain
    });

    const publicUrl = tunnel.url;
    console.log('\n=================================================================');
    console.log(`🚀 CARDIOX AI IS LIVE ON THE PUBLIC INTERNET!`);
    console.log(`🌐 Public HTTPS URL: ${publicUrl}`);
    console.log(`📡 Real-time Telemetry Gateway (WSS): ${publicUrl.replace('https:', 'wss:')}/ws`);
    console.log(`🩺 Health Check: ${publicUrl}/health`);
    console.log('=================================================================\n');

    fs.writeFileSync(urlFile, publicUrl, 'utf8');

    // Keep Node process event loop alive indefinitely
    const keepAliveTimer = setInterval(() => {}, 60000);

    tunnel.on('close', () => {
      clearInterval(keepAliveTimer);
      console.warn('[Tunnel Manager] Tunnel closed. Reconnecting in 3 seconds...');
      setTimeout(() => launchTunnel(index), 3000);
    });

    tunnel.on('error', (err) => {
      clearInterval(keepAliveTimer);
      console.warn('[Tunnel Manager] Tunnel error:', err.message);
      tunnel.close();
    });

  } catch (err) {
    console.error(`[Tunnel Manager] Error initializing tunnel (${err.message}). Trying next subdomain in 4s...`);
    setTimeout(() => launchTunnel(index + 1), 4000);
  }
}

launchTunnel(0);
