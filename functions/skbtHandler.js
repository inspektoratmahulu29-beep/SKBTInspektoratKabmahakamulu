// Fungsi helper response JSON
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

// ============ GOOGLE DRIVE INTEGRATION (Opsional) ============
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

async function uploadToGoogleDrive(env, filePath, fileName, bytes, rootFolderId) {
  const accessToken = await getGoogleAccessToken(env);
  const pathSegments = filePath.split('/');
  pathSegments.pop();
  let currentFolderId = rootFolderId;
  for (const folderName of pathSegments) {
    if (!folderName) continue;
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

export const onRequest = async ({ request, env }) => {
  const url = new URL(request.url);
  let params = {};
  let action = url.searchParams.get('action') || '';

  if (request.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
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
      // Daftar dokumen yang wajib diupload
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

      // Submit pengajuan baru
      case 'submitPengajuan': {
        const { nama_pemohon, nip, jabatan, unit_kerja, dokumen_list } = params;
        const nomor = 'SKBT-' + Date.now().toString().slice(-8) + '-' + Math.floor(Math.random() * 100);

        const insert = await env.DB.prepare(
          `INSERT INTO skbt_submissions (nomor_pengajuan, nama_pemohon, nip, jabatan, unit_kerja, status_verifikasi)
           VALUES (?, ?, ?, ?, ?, 'Menunggu Verifikasi Irban')`
        ).bind(nomor, nama_pemohon, nip, jabatan, unit_kerja).run();

        const subId = insert.meta.last_row_id;

        // Simpan daftar dokumen yang dipilih
        for (const doc of dokumen_list || []) {
          await env.DB.prepare(
            `INSERT INTO skbt_documents (submission_id, dokumen_code, nama_dokumen)
             VALUES (?, ?, ?)`
          ).bind(subId, doc.code, doc.nama).run();
        }

        return jsonResponse({ status: 'success', msg: 'Pengajuan berhasil dibuat', nomor_pengajuan: nomor, id: subId });
      }

      // Upload file per dokumen
      case 'uploadDocument': {
        const { submission_id, dokumen_code, nama_dokumen, file_name, file_data } = params;
        const bytes = Uint8Array.from(atob(file_data), c => c.charCodeAt(0));
        const r2Path = `skbt/${submission_id}/${dokumen_code}/${Date.now()}_${file_name}`;

        // Simpan ke R2
        await env.EVIDENCE_BUCKET.put(r2Path, bytes, { httpMetadata: { contentType: 'application/octet-stream' } });
        const publicUrl = `https://pub-xxxx.r2.dev/${r2Path}`; // Ganti dengan URL R2 Anda

        // Simpan ke Google Drive (jika diatur)
        let gdriveId = null;
        if (env.GOOGLE_DRIVE_CLIENT_ID && env.GOOGLE_DRIVE_CLIENT_SECRET && env.GOOGLE_DRIVE_REFRESH_TOKEN && env.GOOGLE_DRIVE_FOLDER_ID) {
          try {
            gdriveId = await uploadToGoogleDrive(env, r2Path, file_name, bytes, env.GOOGLE_DRIVE_FOLDER_ID);
          } catch (e) {
            console.error('GDrive upload failed:', e);
          }
        }

        // Update metadata di D1
        await env.DB.prepare(
          `UPDATE skbt_documents SET file_name = ?, file_url = ?, gdrive_id = ? WHERE submission_id = ? AND dokumen_code = ?`
        ).bind(file_name, publicUrl, gdriveId, submission_id, dokumen_code).run();

        return jsonResponse({ status: 'success', url: publicUrl, gdrive_id: gdriveId });
      }

      // Verifikasi oleh Irban
      case 'verifyStep': {
        const { submission_id, level, verifier_name, status, catatan } = params;
        const statusText = status === 'setuju' ? `Disetujui Irban ${level}` : `Ditolak Irban ${level}`;

        // Update status di tabel pengajuan
        await env.DB.prepare(
          `UPDATE skbt_submissions SET status_verifikasi = ?, current_level = ? WHERE id = ?`
        ).bind(statusText, level + 1, submission_id).run();

        // Log verifikasi
        await env.DB.prepare(
          `INSERT INTO skbt_verification_logs (submission_id, level_verifikasi, verifier_name, status, catatan) VALUES (?, ?, ?, ?, ?)`
        ).bind(submission_id, level, verifier_name, status, catatan).run();

        return jsonResponse({ status: 'success', msg: 'Verifikasi berhasil disimpan' });
      }

      // Ambil semua pengajuan
      case 'getAllPengajuan': {
        const { results } = await env.DB.prepare("SELECT * FROM skbt_submissions ORDER BY created_at DESC").all();
        return jsonResponse(results);
      }

      // Ambil detail pengajuan
      case 'getPengajuanById': {
        const { id } = params;
        const sub = await env.DB.prepare("SELECT * FROM skbt_submissions WHERE id = ?").bind(id).first();
        const docs = await env.DB.prepare("SELECT * FROM skbt_documents WHERE submission_id = ?").bind(id).all();
        return jsonResponse({ submission: sub, documents: docs.results });
      }

      default:
        return jsonResponse({ status: 'error', msg: 'Aksi tidak dikenal' });
    }
  } catch (err) {
    return jsonResponse({ status: 'error', msg: 'Error: ' + err.message });
  }
};
