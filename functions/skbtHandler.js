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

async function uploadFileToGoogleDrive(env, folderPath, fileName, bytes, rootFolderId) {
  const accessToken = await getGoogleAccessToken(env);
  let currentFolderId = rootFolderId;
  const pathSegments = folderPath.split('/').filter(Boolean);

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

// ============ SEND EMAIL NOTIFICATION (Resend) ============
async function sendEmailNotification(env, submission, documents) {
  if (!env.RESEND_API_KEY || !env.ADMIN_EMAIL) return;
  try {
    const docList = documents.map(d => `<li>${d.nama_dokumen} (${d.file_name})</li>`).join('');
    const emailBody = `<div style="font-family: Arial, sans-serif; background: #f4f7fb; padding: 20px;">
        <h2 style="color: #03045e;">Pengajuan SKBT Baru</h2>
        <p>Sebuah pengajuan baru telah dibuat dan dokumen telah diunggah.</p>
        <table style="width: 100%; border-collapse: collapse;">
          <tr><td style="padding: 8px; font-weight: bold; width: 150px;">Nomor</td><td>: ${submission.nomor_pengajuan}</td></tr>
          <tr><td style="padding: 8px; font-weight: bold;">Nama</td><td>: ${submission.nama_pemohon}</td></tr>
          <tr><td style="padding: 8px; font-weight: bold;">NIP</td><td>: ${submission.nip || '-'}</td></tr>
          <tr><td style="padding: 8px; font-weight: bold;">Pangkat/Golongan</td><td>: ${submission.pangkat_golongan || '-'}</td></tr>
          <tr><td style="padding: 8px; font-weight: bold;">Jabatan</td><td>: ${submission.jabatan || '-'}</td></tr>
          <tr><td style="padding: 8px; font-weight: bold;">Unit Kerja</td><td>: ${submission.unit_kerja}</td></tr>
          <tr><td style="padding: 8px; font-weight: bold;">No HP</td><td>: ${submission.nomor_hp || '-'}</td></tr>
          <tr><td style="padding: 8px; font-weight: bold;">Gmail</td><td>: ${submission.gmail || '-'}</td></tr>
          <tr><td style="padding: 8px; font-weight: bold;">Keperluan</td><td>: ${submission.keperluan || '-'}</td></tr>
        </table>
        <h3 style="color: #0077b6;">Dokumen yang Diupload:</h3>
        <ul>${docList}</ul>
      </div>`;

    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'Pengajuan SKBT <onboarding@resend.dev>', to: env.ADMIN_EMAIL, subject: 'Pengajuan SKBT Baru: ' + submission.nomor_pengajuan, html: emailBody })
    });
    console.log('Email Status:', res.status, await res.json());
  } catch (e) { console.error('Gagal kirim email:', e); }
}
// ============ END EMAIL ============

// ============ UTILITAS UNTUK MENENTUKAN CONTENT-TYPE ============
function getContentType(fileName) {
  const ext = fileName.split('.').pop().toLowerCase();
  const mimeTypes = {
    pdf: 'application/pdf',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    bmp: 'image/bmp',
    svg: 'image/svg+xml',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ppt: 'application/vnd.ms-powerpoint',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    txt: 'text/plain',
    csv: 'text/csv',
  };
  return mimeTypes[ext] || 'application/octet-stream';
}
// ============ END UTILITAS ============

// ACTION HANDLER
export const onRequest = async ({ request, env }) => {
  const url = new URL(request.url);
  let params = {};
  let action = url.searchParams.get('action') || '';

  if (request.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
      }
    });
  }

  if (request.method === 'POST') {
    try {
      params = await request.json();
      if (!action && params.action) action = params.action;
    } catch (e) {
      return jsonResponse({ status: 'error', msg: 'Invalid JSON body' });
    }
  } else {
    url.searchParams.forEach((value, key) => { params[key] = value; });
  }

  try {
    switch (action) {
      // ============ STEP 1: SUBMIT PENGAJUAN (DENGAN PANGKAT/GOLONGAN & KEPERLUAN) ============
      case 'submitPengajuan': {
        const { nama_pemohon, nip, pangkat_golongan, jabatan, unit_kerja, nomor_hp, gmail, keperluan } = params;
        const nomor = 'SKBT-' + Date.now().toString().slice(-8) + '-' + Math.floor(Math.random() * 100);

        const insert = await env.DB.prepare(
          `INSERT INTO skbt_submissions (nomor_pengajuan, nama_pemohon, nip, pangkat_golongan, jabatan, unit_kerja, nomor_hp, gmail, keperluan, status_verifikasi, current_level)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'Draft', 1)`
        ).bind(nomor, nama_pemohon, nip, pangkat_golongan, jabatan, unit_kerja, nomor_hp, gmail, keperluan || '').run();

        const subId = insert.meta.last_row_id;
        return jsonResponse({ status: 'success', msg: 'Data Pemohon tersimpan', id: subId, nomor_pengajuan: nomor });
      }

      // ============ STEP 2: UPLOAD FILE KE R2 ============
      case 'uploadDocument': {
        const { submission_id, dokumen_code, nama_dokumen, file_name, file_data, nama_pemohon } = params;
        
        try {
          const decoded = atob(file_data);
          const bytes = Uint8Array.from(decoded, c => c.charCodeAt(0));

          if (bytes.length > 5 * 1024 * 1024) {
            return jsonResponse({ status: 'error', msg: 'File terlalu besar! Maksimal 5MB.' });
          }

          const safeNama = (nama_pemohon || 'Pemohon').replace(/[^a-zA-Z0-9]/g, '_');
          const r2Path = `skbt/${submission_id}/${dokumen_code}/${safeNama}_${Date.now()}_${file_name}`;
          const publicUrl = `https://pub-68de0ab1691946469b18177ed5ce1404.r2.dev/${r2Path}`;

          const contentType = getContentType(file_name);

          await env.EVIDENCE_BUCKET.put(r2Path, bytes, { httpMetadata: { contentType: contentType } });

          await env.DB.prepare(
            `INSERT INTO skbt_documents (submission_id, dokumen_code, nama_dokumen, file_name, file_url, gdrive_id)
             VALUES (?, ?, ?, ?, ?, NULL)`
          ).bind(submission_id, dokumen_code, nama_dokumen, file_name, publicUrl).run();

          return jsonResponse({ status: 'success', url: publicUrl, msg: 'File tersimpan di server' });
        } catch (e) {
          console.error('Error uploadDocument:', e.message);
          return jsonResponse({ status: 'error', msg: 'Terjadi kesalahan saat menyimpan file: ' + e.message });
        }
      }

      // ============ STEP 3: FINALISASI (UPLOAD DRIVE + EMAIL + NOMOR) ============
      case 'finalizeSubmission': {
        const { submission_id, nama_pemohon } = params;
        
        const sub = await env.DB.prepare("SELECT * FROM skbt_submissions WHERE id = ?").bind(submission_id).first();
        if (!sub) return jsonResponse({ status: 'error', msg: 'Pengajuan tidak ditemukan' });

        const docs = await env.DB.prepare("SELECT * FROM skbt_documents WHERE submission_id = ?").bind(submission_id).all();
        const documents = docs.results;

        for (const doc of documents) {
          if (doc.file_url && doc.file_url.includes('r2.dev/')) {
            try {
              const marker = 'r2.dev/';
              const idx = doc.file_url.indexOf(marker);
              if (idx === -1) continue;
              
              const r2Path = decodeURIComponent(doc.file_url.substring(idx + marker.length));
              const r2Object = await env.EVIDENCE_BUCKET.get(r2Path);
              if (!r2Object) {
                console.error('File tidak ditemukan di R2:', r2Path);
                continue;
              }
              
              const bytes = await r2Object.arrayBuffer();
              const folderPath = `${nama_pemohon}/${doc.dokumen_code}`;
              const gdriveId = await uploadFileToGoogleDrive(env, folderPath, doc.file_name, new Uint8Array(bytes), env.GOOGLE_DRIVE_FOLDER_ID);
              
              await env.DB.prepare("UPDATE skbt_documents SET gdrive_id = ? WHERE id = ?").bind(gdriveId, doc.id).run();
            } catch (e) {
              console.error('Gagal upload ke Drive:', doc.file_name, e.message);
            }
          }
        }

        await sendEmailNotification(env, sub, documents);

        await env.DB.prepare(`UPDATE skbt_submissions SET status_verifikasi = 'Menunggu Irban' WHERE id = ?`).bind(submission_id).run();

        return jsonResponse({ status: 'success', msg: 'Pengajuan berhasil dikirim', nomor_pengajuan: sub.nomor_pengajuan });
      }

      // ============ AMBIL DETAIL PENGAJUAN ============
      case 'getPengajuanById': {
        const { id } = params;
        const sub = await env.DB.prepare("SELECT * FROM skbt_submissions WHERE id = ?").bind(id).first();
        const docs = await env.DB.prepare("SELECT * FROM skbt_documents WHERE submission_id = ?").bind(id).all();
        return jsonResponse({ submission: sub, documents: docs.results });
      }

      // ============ DASHBOARD ============
      case 'getAllPengajuan': {
        const { results } = await env.DB.prepare("SELECT * FROM skbt_submissions ORDER BY created_at DESC").all();
        return jsonResponse(results);
      }

      default:
        return jsonResponse({ status: 'error', msg: 'Aksi tidak dikenal' });
    }
  } catch (err) {
    console.error('Error di handler:', err);
    return jsonResponse({ status: 'error', msg: 'Error: ' + err.message });
  }
};
