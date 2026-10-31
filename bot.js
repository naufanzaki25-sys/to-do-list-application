require('dotenv').config();
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcodeTerminal = require('qrcode-terminal');
const QRCode = require('qrcode');
const { createClient } = require('@supabase/supabase-js');
const http = require('http');
const path = require('path');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;
const PORT = process.env.PORT || 3000;

let supabase = null;
if (SUPABASE_URL && SUPABASE_KEY && !SUPABASE_URL.includes('xxxx')) {
  supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
  console.log('🟢 Database Supabase terhubung.');
} else {
  console.log('🟡 Supabase belum dikonfigurasi di .env.');
}

// Status bot untuk dashboard web di Render
let botStatus = 'Memulai bot...';
let qrDataUrl = null;
let connectedUser = null;

// ================= HTTP SERVER UNTUK RENDER.COM =================
// Menjaga agar Render Web Service tetap aktif & menyediakan tampilan QR Code di browser
const server = http.createServer(async (req, res) => {
  if (req.url === '/health' || req.url === '/ping') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('OK');
  }

  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  const html = `
  <!DOCTYPE html>
  <html lang="id">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>WhatsApp Bot Dashboard — Render Cloud</title>
    <style>
      body {
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        background: #0f172a;
        color: #f8fafc;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        min-height: 100vh;
        margin: 0;
        padding: 20px;
        box-sizing: border-box;
      }
      .card {
        background: #1e293b;
        border-radius: 24px;
        padding: 28px;
        max-width: 420px;
        width: 100%;
        text-align: center;
        box-shadow: 0 20px 40px rgba(0,0,0,0.4);
        border: 1px solid #334155;
      }
      .badge {
        display: inline-block;
        padding: 6px 14px;
        border-radius: 20px;
        font-size: 12px;
        font-weight: 700;
        margin-bottom: 16px;
      }
      .badge-connected { background: #14532d; color: #4ade80; border: 1px solid #22c55e; }
      .badge-waiting { background: #78350f; color: #fde047; border: 1px solid #eab308; }
      .qr-box {
        background: #ffffff;
        padding: 16px;
        border-radius: 16px;
        display: inline-block;
        margin: 16px 0;
      }
      .qr-img { width: 220px; height: 220px; display: block; }
      .instructions {
        font-size: 12px;
        color: #94a3b8;
        line-height: 1.6;
        text-align: left;
        background: #0f172a;
        padding: 14px;
        border-radius: 12px;
        margin-top: 14px;
      }
      .refresh-btn {
        background: #2563eb;
        color: #fff;
        border: none;
        padding: 10px 18px;
        border-radius: 12px;
        font-weight: 700;
        font-size: 13px;
        cursor: pointer;
        margin-top: 14px;
      }
    </style>
  </head>
  <body>
    <div class="card">
      <h2 style="margin: 0 0 6px 0; font-size: 20px;">🤖 WhatsApp Bot Cloud</h2>
      <p style="color: #94a3b8; font-size: 13px; margin: 0 0 16px 0;">Personal Jobdesk & Approval</p>

      ${
        connectedUser
          ? `
          <div class="badge badge-connected">🟢 Terhubung Aktif</div>
          <p style="font-size: 15px; font-weight: 700; margin: 10px 0;">WhatsApp Tersambung!</p>
          <p style="color: #94a3b8; font-size: 12px;">Akun: <b>${connectedUser}</b></p>
          <div class="instructions">
            ✅ Bot sedang aktif 24 jam di cloud Render.<br/>
            Klien bisa langsung kirim pesan di WA:<br/>
            • <code>!tugas Nama Tugas, 14:00, Tinggi</code><br/>
            • <code>!list</code> untuk melihat tugas.
          </div>
        `
          : qrDataUrl
          ? `
          <div class="badge badge-waiting">🟡 Menunggu Scan QR</div>
          <div class="qr-box">
            <img class="qr-img" src="${qrDataUrl}" alt="WhatsApp QR Code" />
          </div>
          <div class="instructions">
            <b>Cara Menghubungkan:</b><br/>
            1. Buka WhatsApp di HP Anda/Klien.<br/>
            2. Buka menu <b>Perangkat Tertaut (Linked Devices)</b>.<br/>
            3. Pilih <b>Tautkan Perangkat</b> dan scan QR di atas.
          </div>
          <button class="refresh-btn" onclick="location.reload()">🔄 Refresh Halaman</button>
        `
          : `
          <div class="badge badge-waiting">⏳ Memuat QR Code...</div>
          <p style="font-size: 13px; color: #94a3b8;">Sedang mempersiapkan koneksi WhatsApp...</p>
          <button class="refresh-btn" onclick="location.reload()">🔄 Cek Ulang</button>
        `
      }
    </div>
  </body>
  </html>
  `;
  res.end(html);
});

server.listen(PORT, () => {
  console.log(`🌐 Server Web aktif di port ${PORT} (siap untuk Render.com).`);
});

// ================= PROGRAM UTAMA WHATSAPP BOT =================
const STATUS_LABEL = {
  pending: '⏳ Belum Mulai (0%)',
  in_progress: '🔨 Sedang Dikerjakan',
  waiting_approval: '🔔 Siap Di-Approve (100%)',
  approved: '✅ Approved (Tuntas)'
};

async function startWhatsAppBot() {
  const authPath = path.join(__dirname, 'auth_info_baileys');
  const { state, saveCreds } = await useMultiFileAuthState(authPath);
  const { version, isLatest } = await fetchLatestBaileysVersion();

  console.log(`🚀 Menjalankan WhatsApp Bot (Baileys v${version.join('.')}, isLatest: ${isLatest})...`);

  const sock = makeWASocket({
    version,
    logger: pino({ level: 'silent' }),
    auth: state,
    printQRInTerminal: false
  });

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      botStatus = 'Menunggu scan QR';
      connectedUser = null;
      try {
        qrDataUrl = await QRCode.toDataURL(qr);
      } catch (e) {
        console.error('Gagal generate QR DataURL:', e);
      }

      console.log('\n📲 QR CODE WHATSAPP:');
      qrcodeTerminal.generate(qr, { small: true });
      console.log('Atau buka halaman web untuk scan langsung di browser!\n');
    }

    if (connection === 'close') {
      connectedUser = null;
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      console.log(`⚠️ Koneksi terputus (status: ${statusCode}). Reconnect: ${shouldReconnect}`);
      if (shouldReconnect) {
        startWhatsAppBot();
      } else {
        console.log('❌ Logout dari WhatsApp. Hapus folder auth_info_baileys untuk scan baru.');
      }
    } else if (connection === 'open') {
      botStatus = 'Terhubung';
      qrDataUrl = null;
      connectedUser = sock.user?.id ? sock.user.id.split(':')[0] : 'Aktif';
      console.log(`✅ WHATSAPP BOT TERHUBUNG SEBAGAI: ${connectedUser}`);
    }
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('messages.upsert', async (m) => {
    const msg = m.messages[0];
    if (!msg.message) return;

    const text =
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text ||
      msg.message.imageMessage?.caption ||
      '';

    const cleanText = text.trim();
    if (!cleanText) return;

    const fromJid = msg.key.remoteJid;
    if (fromJid === 'status@broadcast') return;

    const ownerNumber = process.env.OWNER_PHONE_NUMBER?.replace(/\D/g, '');
    if (ownerNumber && !fromJid.includes(ownerNumber) && !msg.key.fromMe) {
      return;
    }

    // 1. Menu Bantuan
    if (/^(!menu|!help|!bantuan)$/i.test(cleanText)) {
      const menuText =
        `📋 *PANDUAN BOT JOBDESK & APPROVAL*\n\n` +
        `Format perintah chat praktis:\n\n` +
        `1️⃣ *Tambah Tugas Baru:*\n` +
        `   • Pakai Koma: \`!tugas Desain Banner, 14:00, Tinggi\`\n` +
        `   • Cukup Nama Saja: \`!tugas Desain Banner\`\n\n` +
        `2️⃣ *Lihat Daftar Pekerjaan:*\n` +
        `   Ketik: \`!list\`\n\n` +
        `3️⃣ *Update Progres Pengerjaan:*\n` +
        `   Ketik: \`!progres <ID> <Persen>\` (misal: \`!progres 1 75\`)\n\n` +
        `4️⃣ *Approve & Selesaikan Tugas:*\n` +
        `   Ketik: \`!approve <ID>\` atau \`!selesai <ID>\`\n\n` +
        `5️⃣ *Hapus Tugas:*\n` +
        `   Ketik: \`!hapus <ID>\``;

      return await sock.sendMessage(fromJid, { text: menuText }, { quoted: msg });
    }

    // 2. Tambah Tugas Baru (!tugas ...)
    if (/^(!tugas|!tambah|#tugas|#todo)\s+/i.test(cleanText)) {
      const rawPayload = cleanText.replace(/^(!tugas|!tambah|#tugas|#todo)\s+/i, '');

      // Pisahkan dengan koma, enter, strip, atau baris vertikal
      let parts = [];
      if (rawPayload.includes('|')) {
        parts = rawPayload.split('|');
      } else if (rawPayload.includes('\n')) {
        parts = rawPayload.split('\n');
      } else if (rawPayload.includes(',')) {
        parts = rawPayload.split(',');
      } else if (rawPayload.includes(' - ')) {
        parts = rawPayload.split(' - ');
      } else {
        parts = [rawPayload];
      }
      parts = parts.map((s) => s.trim()).filter(Boolean);

      const title = parts[0];
      const deadline = parts[1] || 'Hari Ini';
      const prioInput = (parts[2] || 'Sedang').toLowerCase();
      const priority =
        prioInput.includes('low') || prioInput.includes('santai') || prioInput.includes('rendah')
          ? 'Low'
          : prioInput.includes('high') || prioInput.includes('tinggi') || prioInput.includes('urgent')
          ? 'High'
          : 'Medium';

      if (!title) {
        return await sock.sendMessage(fromJid, { text: '❌ Nama tugas tidak boleh kosong.' }, { quoted: msg });
      }

      if (supabase) {
        const { data, error } = await supabase
          .from('tasks')
          .insert([
            {
              title,
              description: 'Diinput melalui WhatsApp Bot Cloud',
              deadline,
              priority,
              progress: 0,
              status: 'pending',
              source: 'WhatsApp'
            }
          ])
          .select()
          .single();

        if (error) {
          return await sock.sendMessage(fromJid, { text: `❌ Gagal menyimpan ke database: ${error.message}` }, { quoted: msg });
        }

        const reply =
          `✅ *TUGAS BARU DICATAT KE APLIKASI*\n\n` +
          `🆔 *ID:* #${data.id}\n` +
          `📌 *Pekerjaan:* ${data.title}\n` +
          `⏰ *Target:* ${data.deadline}\n` +
          `⚡ *Prioritas:* ${data.priority === 'High' ? 'Tinggi' : data.priority === 'Low' ? 'Santai' : 'Sedang'}\n` +
          `📊 *Progres:* 0% (Belum Mulai)\n\n` +
          `_Untuk update progres ketik:_ \`!progres ${data.id} 50\``;

        return await sock.sendMessage(fromJid, { text: reply }, { quoted: msg });
      } else {
        return await sock.sendMessage(
          fromJid,
          { text: `✅ *[Mode Simulasi]* Tugas "${title}" berhasil diterima!` },
          { quoted: msg }
        );
      }
    }

    // 3. Lihat Daftar Tugas Aktif (!list)
    if (/^(!list|!daftar)$/i.test(cleanText)) {
      if (!supabase) {
        return await sock.sendMessage(fromJid, { text: '⚠️ Supabase belum terhubung.' }, { quoted: msg });
      }

      const { data: tasks, error } = await supabase
        .from('tasks')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(10);

      if (error) {
        return await sock.sendMessage(fromJid, { text: `❌ Gagal mengambil data: ${error.message}` }, { quoted: msg });
      }

      if (!tasks || tasks.length === 0) {
        return await sock.sendMessage(
          fromJid,
          { text: '📭 Daftar pekerjaan Anda saat ini masih kosong.\nKetik `!tugas <Nama Tugas>` untuk mencatat baru.' },
          { quoted: msg }
        );
      }

      let listText = `📋 *DAFTAR PEKERJAAN ANDA*\n\n`;
      tasks.forEach((t) => {
        const iconPrio = t.priority === 'High' ? '🔴' : t.priority === 'Medium' ? '🟡' : '🟢';
        listText +=
          `🆔 *#${t.id}* — *${t.title}*\n` +
          `   ${iconPrio} Prioritas: ${t.priority} | ⏰ Target: ${t.deadline || 'Hari Ini'}\n` +
          `   📊 Progres: ${t.progress}% (${STATUS_LABEL[t.status] || t.status})\n\n`;
      });
      listText += `_Ketik \`!progres <id> <persen>\` atau \`!approve <id>\` untuk mengesahkan selesai._`;

      return await sock.sendMessage(fromJid, { text: listText }, { quoted: msg });
    }

    // 4. Update Progres (!progres <id> <angka>)
    const progMatch = cleanText.match(/^!progres\s+(\d+)\s+(\d+)/i);
    if (progMatch) {
      const taskId = parseInt(progMatch[1], 10);
      const percent = Math.min(100, Math.max(0, parseInt(progMatch[2], 10)));
      const newStatus = percent === 100 ? 'waiting_approval' : percent === 0 ? 'pending' : 'in_progress';

      if (!supabase) return;

      const { data, error } = await supabase
        .from('tasks')
        .update({
          progress: percent,
          status: newStatus,
          updated_at: new Date().toISOString()
        })
        .eq('id', taskId)
        .select()
        .single();

      if (error || !data) {
        return await sock.sendMessage(fromJid, { text: `❌ Tugas dengan ID #${taskId} tidak ditemukan.` }, { quoted: msg });
      }

      let reply = `📊 *PROGRES DIPERBARUI!*\n📌 *#${data.id} ${data.title}* diupdate ke *${data.progress}%*.`;
      if (percent === 100) {
        reply += `\n\n🔔 *Tugas sudah 100%!* Ketik \`!approve ${data.id}\` untuk mengesahkan selesai.`;
      }

      return await sock.sendMessage(fromJid, { text: reply }, { quoted: msg });
    }

    // 5. Self-Approve (!approve <id> atau !selesai <id>)
    const appMatch = cleanText.match(/^!(approve|selesai|acc)\s+(\d+)/i);
    if (appMatch) {
      const taskId = parseInt(appMatch[2], 10);
      if (!supabase) return;

      const { data, error } = await supabase
        .from('tasks')
        .update({
          progress: 100,
          status: 'approved',
          progress_note: 'Disetujui & disahkan via WhatsApp',
          updated_at: new Date().toISOString()
        })
        .eq('id', taskId)
        .select()
        .single();

      if (error || !data) {
        return await sock.sendMessage(fromJid, { text: `❌ Tugas dengan ID #${taskId} tidak ditemukan.` }, { quoted: msg });
      }

      return await sock.sendMessage(
        fromJid,
        { text: `✅ *APPROVED & TUNTAS!*\n🎉 Tugas *#${data.id} — ${data.title}* telah disahkan selesai.` },
        { quoted: msg }
      );
    }

    // 6. Hapus Tugas (!hapus <id>)
    const delMatch = cleanText.match(/^!(hapus|delete)\s+(\d+)/i);
    if (delMatch) {
      const taskId = parseInt(delMatch[2], 10);
      if (!supabase) return;

      await supabase.from('tasks').delete().eq('id', taskId);
      return await sock.sendMessage(
        fromJid,
        { text: `🗑 Tugas *#${taskId}* telah dihapus dari daftar aplikasi.` },
        { quoted: msg }
      );
    }
  });
}

startWhatsAppBot().catch((err) => {
  console.error('❌ Gagal menjalankan WhatsApp Bot:', err);
});
