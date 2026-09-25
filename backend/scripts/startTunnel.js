import localtunnel from 'localtunnel';

async function startTunnel(retryCount = 0) {
  try {
    const desiredSubdomain = 'cardiox-telemetry-' + Math.floor(1000 + Math.random() * 9000);
    console.log(`[Tunnel] Opening public HTTPS tunnel for port 5000 (subdomain: ${desiredSubdomain})...`);
    
    const tunnel = await localtunnel({
      port: 5000,
      subdomain: desiredSubdomain
    });

    console.log('\n======================================================');
    console.log(`🌐 CARDIOX PUBLIC HTTPS URL: ${tunnel.url}`);
    console.log(`📡 WebSocket Telemetry Gateway: ${tunnel.url.replace('https:', 'wss:')}/ws`);
    console.log('======================================================\n');

    tunnel.on('close', () => {
      console.warn('[Tunnel] Connection closed. Reconnecting in 3s...');
      setTimeout(() => startTunnel(retryCount + 1), 3000);
    });

    tunnel.on('error', (err) => {
      console.warn('[Tunnel] Error:', err.message);
      tunnel.close();
    });

  } catch (err) {
    console.error('[Tunnel] Failed to initialize tunnel:', err.message);
    setTimeout(() => startTunnel(retryCount + 1), 5000);
  }
}

startTunnel();
