// Helper response JSON yang aman (CORS)
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}

// ============ GOOGLE DRIVE INTEGRATION ============
async function getGoogleAccessToken(env) {
  const { GOOGLE_DRIVE_CLIENT_ID, GOOGLE_DRIVE_CLIENT_SECRET, GOOGLE_DRIVE_REFRESH_TOKEN } = env;
  if (!GOOGLE_DRIVE_CLIENT_ID || !GOOGLE_DRIVE_CLIENT_SECRET || !GOOGLE_DRIVE_REFRESH_TOKEN) {
    throw new Error('Google Drive credentials not configured');
  }
  const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: GOOGLE_DRIVE_CLIENT_ID,
      client_secret: GOOGLE_DRIVE_CLIENT_SECRET,
      refresh_token: GOOGLE_DRIVE_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }),
  });
  const tokenData = await tokenResponse.json();
  if (!tokenResponse.ok) throw new Error('Failed to get Google Drive access token: ' + JSON.stringify(tokenData));
  return tokenData.access_token;
}

async function createFolder(accessToken, parentId, folderName) {
  const response = await fetch('https://www.googleapis.com/drive/v3/files', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: folderName, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error('Gagal membuat folder: ' + JSON.stringify(data));
  return data.id;
}

async function getOrCreateFolder(accessToken, parentId, folderName) {
  const query = `name='${folderName}' and mimeType='application/vnd.google-apps.folder' and '${parentId}' in parents and trashed=false`;
  const response = await fetch(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&fields=files(id,name)`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const data = await response.json();
  if (data.files && data.files.length > 0) return data.files[0].id;
  return await createFolder(accessToken, parentId, folderName);
}

async function uploadToGoogleDrive(env, folderPath, fileName, bytes, rootFolderId) {
  const accessToken = await getGoogleAccessToken(env);
  const pathSegments = folderPath.split('/').filter(Boolean);

  // Mulai dari root folder ID
  let currentFolderId = rootFolderId;
  for (const folderName of pathSegments) {
    currentFolderId = await getOrCreateFolder(accessToken, currentFolderId, folderName);
  }

  const metadata = { name: fileName, parents: [currentFolderId] };
  const initResponse = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Type': 'application/octet-stream',
      'X-Upload-Content-Length': bytes.length.toString(),
    },
    body: JSON.stringify(metadata),
  });
  if (!initResponse.ok) throw new Error('Gagal inisialisasi upload: ' + await initResponse.text());
  const location = initResponse.headers.get('Location');
  if (!location) throw new Error('Tidak ada URL upload dari Google Drive');
  const uploadResponse = await fetch(location, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': bytes.length.toString() },
    body: bytes,
  });
  const result = await uploadResponse.json();
  if (!uploadResponse.ok) throw new Error('Gagal upload file ke Google Drive: ' + JSON.stringify(result));
  return result.id;
}
// ============ END GOOGLE DRIVE ============

// ============ SEND EMAIL NOTIFICATION ============
async function sendEmailNotification(env, submission, documents) {
  if (!env.RESEND_API_KEY || !env.ADMIN_EMAIL) return;
  try {
    const docList = documents.map(d => `<li>${d.nama_dokumen}</li>`).join('');
    const emailBody = `<div style="font-family: Arial, sans-serif; background: #f4f7fb; padding: 20px;">
        <h2 style="color: #03045e;">Pengajuan SKBT Baru</h2>
        <p>Sebuah pengajuan baru telah dibuat.</p>
        <table style="width: 100%; border-collapse: collapse;">
          <tr><td style="padding: 8px; font-weight: bold; width: 150px;">Nomor</td><td>: ${submission.nomor_pengajuan}</td></tr>
          <tr><td style="padding: 8px; font-weight: bold;">Nama</td><td>: ${submission.nama_pemohon}</td></tr>
          <tr><td style="padding: 8px; font-weight: bold;">NIP</td><td>: ${submission.nip || '-'}</td></tr>
          <tr><td style="padding: 8px; font-weight: bold;">Jabatan</td><td>: ${submission.jabatan || '-'}</td></tr>
          <tr><td style="padding: 8px; font-weight: bold;">Unit Kerja</td><td>: ${submission.unit_kerja}</td></tr>
        </table>
        <h3 style="color: #0077b6;">Dokumen yang Diupload:</h3>
        <ul>${docList}</ul>
      </div>`;

    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'onboarding@resend.dev', to: env.ADMIN_EMAIL, subject: 'Pengajuan SKBT Baru: ' + submission.nomor_pengajuan, html: emailBody })
    });
    console.log('Email Status:', res.status, await res.json());
  } catch (e) { console.error('Gagal kirim email:', e); }
}
// ============ END EMAIL ============

// ACTION HANDLER
export const onRequest = async ({ request, env }) => {
  const url = new URL(request.url);
  let params = {};
  let action = url.searchParams.get('action') || '';

  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' } });
  }

  if (request.method === 'POST') {
    try {
      params = await request.json();
      if (!action && params.action) action = params.action;
    } catch (e) { return jsonResponse({ status: 'error', msg: 'Invalid JSON body' }); }
  } else {
    url.searchParams.forEach((value, key) => { params[key] = value; });
  }

  try {
    switch (action) {
      case 'getDokumenList': {
        return jsonResponse([
          { code: 'SKCPNS', nama: 'SK CPNS & PNS' },
          { code: 'SKPangkat', nama: 'SK Pangkat Terakhir' },
          { code: 'SKJabatan', nama: 'SK Jabatan Terakhir' },
          { code: 'SKP', nama: 'SKP 1 atau 2 Tahun Terakhir' },
          { code: 'SuratPermohonan', nama: 'Surat Permohonan' },
          { code: 'SuratPengantar', nama: 'Surat Pengantar dari Pimpinan OPD' },
          { code: 'SKBebasMasalah', nama: 'SK Bebas Masalah' },
          { code: 'SKBendahara', nama: 'SK Status Bebas Hutang/Piutang' }
        ]);
      }

      // ============ SUBMIT PENGAJUAN (STEP 1) ============
      case 'submitPengajuan': {
        const { nama_pemohon, nip, jabatan, unit_kerja, nomor_hp, gmail } = params;
        const nomor = 'SKBT-' + Date.now().toString().slice(-8) + '-' + Math.floor(Math.random() * 100);

        const insert = await env.DB.prepare(
          `INSERT INTO skbt_submissions (nomor_pengajuan, nama_pemohon, nip, jabatan, unit_kerja, nomor_hp, gmail, status_verifikasi, current_level)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'Menunggu Irban', 1)`
        ).bind(nomor, nama_pemohon, nip, jabatan, unit_kerja, nomor_hp, gmail).run();

        const subId = insert.meta.last_row_id;

        // Kirim email (opsional)
        const sub = await env.DB.prepare("SELECT * FROM skbt_submissions WHERE id = ?").bind(subId).first();
        const docs = await env.DB.prepare("SELECT * FROM skbt_documents WHERE submission_id = ?").bind(subId).all();
        await sendEmailNotification(env, sub, docs.results);

        return jsonResponse({ status: 'success', msg: 'Pengajuan berhasil dibuat', nomor_pengajuan: nomor, id: subId });
      }

      // ============ UPLOAD FILE (STEP 2) ============
      case 'uploadDocument': {
        const { submission_id, dokumen_code, nama_dokumen, file_name, file_data, nama_pemohon } = params;
        const bytes = Uint8Array.from(atob(file_data), c => c.charCodeAt(0));
        const r2Path = `skbt/${submission_id}/${dokumen_code}/${Date.now()}_${file_name}`;

        // Simpan ke R2
        await env.EVIDENCE_BUCKET.put(r2Path, bytes, { httpMetadata: { contentType: 'application/octet-stream' } });
        const publicUrl = `https://pub-8e4e0075c2e4428e95f6455b2e2b9826.r2.dev/${r2Path}`; // Ganti dengan URL R2 Anda

        // Simpan ke Google Drive (Folder: Nama Pemohon / Jenis Dokumen)
        let gdriveId = null;
        if (env.GOOGLE_DRIVE_CLIENT_ID && env.GOOGLE_DRIVE_CLIENT_SECRET && env.GOOGLE_DRIVE_REFRESH_TOKEN && env.GOOGLE_DRIVE_FOLDER_ID) {
          try {
            const folderPath = `${nama_pemohon}/${dokumen_code}`;
            gdriveId = await uploadToGoogleDrive(env, folderPath, file_name, bytes, env.GOOGLE_DRIVE_FOLDER_ID);
          } catch (e) { console.error('GDrive upload failed:', e); }
        }

        // Simpan metadata ke D1
        await env.DB.prepare(
          `INSERT INTO skbt_documents (submission_id, dokumen_code, nama_dokumen, file_name, file_url, gdrive_id)
           VALUES (?, ?, ?, ?, ?, ?)`
        ).bind(submission_id, dokumen_code, nama_dokumen, file_name, publicUrl, gdriveId).run();

        return jsonResponse({ status: 'success', url: publicUrl, gdrive_id: gdriveId });
      }

      case 'getPengajuanById': {
        const { id } = params;
        const sub = await env.DB.prepare("SELECT * FROM skbt_submissions WHERE id = ?").bind(id).first();
        const docs = await env.DB.prepare("SELECT * FROM skbt_documents WHERE submission_id = ?").bind(id).all();
        return jsonResponse({ submission: sub, documents: docs.results });
      }

      case 'getAllPengajuan': {
        const { results } = await env.DB.prepare("SELECT * FROM skbt_submissions ORDER BY created_at DESC").all();
        return jsonResponse(results);
      }

      default:
        return jsonResponse({ status: 'error', msg: 'Aksi tidak dikenal' });
    }
  } catch (err) {
    return jsonResponse({ status: 'error', msg: 'Error: ' + err.message });
  }
};
