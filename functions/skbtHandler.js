// ============================================================================
// SKBT PUBLIC HANDLER - Inspektorat Daerah Kabupaten Mahakam Ulu
// Alur: Draft -> upload sementara ke R2 -> finalisasi -> Google Drive + Google Docs
// ============================================================================

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=UTF-8',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    },
  });
}

const MAX_FILE_SIZE = 5 * 1024 * 1024;
const MAX_FILES_PER_DOCUMENT = 2;
const REQUIRED_DOCUMENT_CODES = ['SKPangkat', 'SKJabatan', 'SuratRekomendasiMutasi'];
const OPTIONAL_DOCUMENT_CODES = ['SKBankaltim'];
const ALL_DOCUMENT_CODES = [...REQUIRED_DOCUMENT_CODES, ...OPTIONAL_DOCUMENT_CODES];

// --------------------------------------------------------------------------
// AUTO-MIGRATION (aman untuk database lama)
// --------------------------------------------------------------------------
let schemaReadyPromise = null;
async function addColumnSafe(db, sql) {
  try { await db.prepare(sql).run(); }
  catch (error) { if (!String(error?.message || error).toLowerCase().includes('duplicate column name')) throw error; }
}
async function ensureSchema(env) {
  if (schemaReadyPromise) return schemaReadyPromise;
  schemaReadyPromise = (async () => {
    const submissionCols = await env.DB.prepare('PRAGMA table_info(skbt_submissions)').all();
    const documentCols = await env.DB.prepare('PRAGMA table_info(skbt_documents)').all();
    const submissionNames = new Set((submissionCols.results || []).map(c => c.name));
    const documentNames = new Set((documentCols.results || []).map(c => c.name));

    const submissionAdds = {
      pangkat_golongan: 'TEXT',
      mode_pemohon: "TEXT DEFAULT 'OPD'",
      nomor_hp: 'TEXT',
      gmail: 'TEXT',
      keperluan: 'TEXT',
      catatan_sekretaris: 'TEXT',
      catatan_inspektur: 'TEXT',
      gdrive_folder_id: 'TEXT',
      gdocs_id: 'TEXT',
      gdocs_url: 'TEXT',
      gdocs_pdf_url: 'TEXT',
      gdocs_docx_url: 'TEXT',
    };
    for (const [name, type] of Object.entries(submissionAdds)) {
      if (!submissionNames.has(name)) {
        await addColumnSafe(env.DB, `ALTER TABLE skbt_submissions ADD COLUMN ${name} ${type}`);
      }
    }

    const documentAdds = {
      r2_path: 'TEXT',
      verification_status: "TEXT DEFAULT 'pending'",
      verification_note: "TEXT DEFAULT ''",
    };
    for (const [name, type] of Object.entries(documentAdds)) {
      if (!documentNames.has(name)) {
        await addColumnSafe(env.DB, `ALTER TABLE skbt_documents ADD COLUMN ${name} ${type}`);
      }
    }

    await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_skbt_documents_submission ON skbt_documents(submission_id)').run();
    await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_skbt_documents_code ON skbt_documents(submission_id, dokumen_code)').run();
    await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_skbt_submissions_status ON skbt_submissions(status_verifikasi)').run();
    await env.DB.prepare("UPDATE skbt_submissions SET status_verifikasi = REPLACE(REPLACE(status_verifikasi, 'Irban', 'Sekretaris Inspektorat'), 'Verifikasi Sekretaris Inspektorat Sekretaris Inspektorat', 'Verifikasi Sekretaris Inspektorat'), current_level = CASE WHEN status_verifikasi LIKE '%Sekretaris Inspektorat%' THEN 1 ELSE current_level END WHERE status_verifikasi LIKE '%Irban%'").run();
  })().catch(error => {
    schemaReadyPromise = null;
    throw error;
  });
  return schemaReadyPromise;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function safeFileName(value) {
  return String(value || 'file')
    .replace(/[^a-zA-Z0-9._ -]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 150) || 'file';
}

function safeFolderName(value) {
  return String(value || 'Pemohon')
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 150) || 'Pemohon';
}

function getContentType(fileName) {
  const ext = String(fileName || '').split('.').pop().toLowerCase();
  const map = {
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
  return map[ext] || 'application/octet-stream';
}

// --------------------------------------------------------------------------
// GOOGLE DRIVE
// --------------------------------------------------------------------------
async function getGoogleAccessToken(env) {
  const clientId = env.GOOGLE_DRIVE_CLIENT_ID;
  const clientSecret = env.GOOGLE_DRIVE_CLIENT_SECRET;
  const refreshToken = env.GOOGLE_DRIVE_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error('Konfigurasi Google Drive belum lengkap (CLIENT_ID/CLIENT_SECRET/REFRESH_TOKEN).');
  }

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });

  const data = await response.json();
  if (!response.ok || !data.access_token) {
    throw new Error('Gagal memperoleh token Google: ' + JSON.stringify(data));
  }
  return data.access_token;
}

async function driveRequest(accessToken, url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      ...(options.headers || {}),
      Authorization: `Bearer ${accessToken}`,
    },
  });

  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (_) { data = { raw: text }; }

  if (!response.ok) {
    throw new Error(`Google Drive API ${response.status}: ${JSON.stringify(data)}`);
  }
  return data;
}

async function createFolder(accessToken, parentId, folderName) {
  return driveRequest(accessToken, 'https://www.googleapis.com/drive/v3/files?fields=id,name', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: folderName,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [parentId],
    }),
  });
}

async function getOrCreateApplicantFolder(accessToken, parentId, folderName, existingFolderId = null) {
  if (existingFolderId) {
    const response = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(existingFolderId)}?fields=id,name,mimeType,trashed`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (response.ok) {
      const existing = await response.json();
      if (existing.id && !existing.trashed && existing.mimeType === 'application/vnd.google-apps.folder') {
        return existing.id;
      }
    }
  }

  // Folder dibuat khusus untuk satu pengajuan dan ID disimpan di DB.
  // Nama folder tetap mengikuti nama pemohon sesuai kebutuhan pengguna.
  const folder = await createFolder(accessToken, parentId, folderName);
  return folder.id;
}

async function uploadFileToGoogleDrive(accessToken, folderId, fileName, bytes, contentType) {
  const metadata = {
    name: safeFileName(fileName),
    parents: [folderId],
  };

  const initResponse = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,name,mimeType', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Type': contentType,
      'X-Upload-Content-Length': String(bytes.byteLength),
    },
    body: JSON.stringify(metadata),
  });

  if (!initResponse.ok) {
    throw new Error('Gagal inisialisasi upload Google Drive: ' + await initResponse.text());
  }

  const location = initResponse.headers.get('Location');
  if (!location) throw new Error('Google Drive tidak mengembalikan URL resumable upload.');

  const uploadResponse = await fetch(location, {
    method: 'PUT',
    headers: {
      'Content-Type': contentType,
      'Content-Length': String(bytes.byteLength),
    },
    body: bytes,
  });

  const resultText = await uploadResponse.text();
  let result;
  try { result = resultText ? JSON.parse(resultText) : {}; } catch (_) { result = { raw: resultText }; }
  if (!uploadResponse.ok || !result.id) {
    throw new Error('Gagal upload file ke Google Drive: ' + JSON.stringify(result));
  }

  return result;
}

async function grantDriveWriterPermission(accessToken, fileId, email) {
  if (!email) return { granted: false, skipped: true };

  const response = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}/permissions?sendNotificationEmail=false`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      type: 'user',
      role: 'writer',
      emailAddress: email,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    console.warn('Gagal memberikan akses edit Google Docs:', body);
    return { granted: false, error: body };
  }

  return { granted: true };
}

// Import HTML sebagai Google Docs agar format surat dapat langsung diedit di Google Docs.
async function createGoogleDocFromHtml(accessToken, folderId, fileName, html, editorEmail) {
  const metadata = {
    name: fileName,
    mimeType: 'application/vnd.google-apps.document',
    parents: [folderId],
  };

  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json; charset=UTF-8' }));
  form.append('file', new Blob([html], { type: 'text/html; charset=UTF-8' }), `${safeFileName(fileName)}.html`);

  const response = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,mimeType', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}` },
    body: form,
  });

  const text = await response.text();
  let result;
  try { result = text ? JSON.parse(text) : {}; } catch (_) { result = { raw: text }; }
  if (!response.ok || !result.id) {
    throw new Error('Gagal membuat Google Docs: ' + JSON.stringify(result));
  }

  const permission = await grantDriveWriterPermission(accessToken, result.id, editorEmail);
  return {
    id: result.id,
    name: result.name,
    editUrl: `https://docs.google.com/document/d/${result.id}/edit`,
    pdfUrl: `https://docs.google.com/document/d/${result.id}/export?format=pdf`,
    docxUrl: `https://docs.google.com/document/d/${result.id}/export?format=docx`,
    driveUrl: `https://drive.google.com/open?id=${result.id}`,
    editorAccessGranted: permission.granted,
    editorAccessError: permission.error || '',
  };
}

function buildApplicationLetterHtml(submission) {
  const nama = escapeHtml(submission.nama_pemohon || '________________________');
  const nip = escapeHtml(submission.nip || '________________________');
  const pangkat = escapeHtml(submission.pangkat_golongan || '________________________');
  const jabatan = escapeHtml(submission.jabatan || '________________________');
  const unit = escapeHtml(submission.unit_kerja || '________________________');
  const hp = escapeHtml(submission.nomor_hp || '________________________');
  const nomor = '';
  const gmail = escapeHtml(submission.gmail || '');
  const dateText = new Date().toLocaleDateString('id-ID', { day: '2-digit', month: 'long', year: 'numeric', timeZone: 'Asia/Makassar' });

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
@page { size: A4; margin: 17mm 18mm 18mm 18mm; }
body { font-family: 'Times New Roman', Times, serif; color:#222; font-size:12pt; line-height:1.42; margin:0; }
.letterhead { width:100%; border-collapse:collapse; margin:0 0 5px; }
.letterhead td { vertical-align:middle; }
.letterhead-logo { width:88px; text-align:left; padding:0 10px 0 0; }
.letterhead-logo img { width:72px; height:82px; object-fit:contain; }
.letterhead-title { text-align:center; color:#000; padding-right:10px; }
.letterhead-title .agency { font-size:12pt; font-weight:800; letter-spacing:.3px; margin-bottom:5px; }
.letterhead-title .line1 { font-size:15pt; font-weight:800; letter-spacing:.2px; margin-bottom:2px; }
.letterhead-title .line2 { font-size:13pt; font-weight:800; letter-spacing:.1px; margin-bottom:2px; }
.letterhead-title .line3 { font-size:13pt; font-weight:800; letter-spacing:.15px; }
.letterhead-rule { border-top:2px solid #000; border-bottom:1px solid #c2a45a; height:4px; margin:0 0 18px; }
.meta { width:100%; border-collapse:collapse; margin-bottom:16px; }
.meta td { padding:2px 0; vertical-align:top; color:#222; }
.meta .label { width:85px; }
.info { width:100%; border-collapse:collapse; margin:12px 0 18px; }
.info td { padding:2px 4px; vertical-align:top; color:#222; }
.info .label { width:160px; }
p { margin:0 0 12px; color:#222; text-align:justify; }
.recipient { margin:4px 0 18px; color:#222; }
ol { margin:6px 0 14px 23px; padding:0; color:#222; }
li { margin-bottom:5px; }
.signature { width:100%; border-collapse:separate; border-spacing:0; margin-top:30px; color:#222; table-layout:fixed; }
.signature td { vertical-align:top; text-align:center; padding:0 18px; border:0; }
.signature .left { padding-left:0; text-align:left; }
.signature .right { padding-right:0; text-align:center; }
.signature-uptd .top td { width:50%; height:205px; }
.signature-uptd .bottom td { width:100%; height:175px; padding-top:12px; }
.sig-space { height:120px; line-height:16px; font-size:11pt; }
.signature-uptd .bottom .sig-space { height:95px; }
.sig-line { margin-top:2px; }
.footer-date { text-align:right; margin-top:12px; color:#222; }
.small { font-size:9pt; color:#666; }
.note { color:#174e49; font-size:9pt; margin-top:18px; }
</style></head><body>
  <table class="letterhead">
    <tr>
      <td class="letterhead-logo"><img src="https://skbtinspektoratkabmahakamulu.pages.dev/logo-mahakam.png" alt="Logo Mahakam Ulu"></td>
      <td class="letterhead-title">
        <div class="line1">SURAT PERMOHONAN</div>
        <div class="line2">PENERBITAN SURAT KETERANGAN BEBAS TEMUAN (SKBT)</div>
        <div class="line3">INSPEKTORAT DAERAH MAHAKAM ULU</div>
      </td>
    </tr>
  </table>
  <div class="letterhead-rule"></div>

  <table class="meta">
    <tr><td class="label">Nomor</td><td>: ${nomor}</td></tr>
    <tr><td class="label">Lampiran</td><td>: 1 (satu) berkas</td></tr>
    <tr><td class="label">Perihal</td><td>: Permohonan Penerbitan Surat Keterangan Bebas Temuan</td></tr>
  </table>

  <div class="recipient">Kepada Yth.<br><b>Inspektur</b><br>Inspektorat Kabupaten Mahakam Ulu<br>di –<br>&nbsp;&nbsp;&nbsp;&nbsp;Ujoh Bilang</div>

  <p>Yang bertanda tangan di bawah ini:</p>
  <table class="info">
    <tr><td class="label">Nama</td><td>: ${nama}</td></tr>
    <tr><td class="label">N I P</td><td>: ${nip}</td></tr>
    <tr><td class="label">Pangkat/Gol.Ruang</td><td>: ${pangkat}</td></tr>
    <tr><td class="label">Jabatan</td><td>: ${jabatan}</td></tr>
    <tr><td class="label">Unit Kerja</td><td>: ${unit}</td></tr>
    <tr><td class="label">Nomor Telepon (HP)</td><td>: ${hp}</td></tr>
  </table>

  <p>dengan ini mengajukan permohonan kepada Bapak untuk diterbitkan Surat Keterangan Bebas Temuan atas hasil pemeriksaan internal maupun eksternal untuk keperluan kelengkapan persyaratan mutasi keluar Kabupaten Mahakam Ulu.</p>

  <p>Sebagai bahan pertimbangan, dengan ini saya lampirkan:</p>
  <ol>
    <li>SK Pangkat terakhir sebanyak 1 lembar</li>
    <li>SK Jabatan Struktural/SK Jabatan Jafung (sesuai jabatan terakhir)</li>
    <li>Surat rekomendasi persetujuan mutasi dari Pimpinan tempat bekerja sebanyak 1 lembar</li>
    <li>Surat keterangan tidak memiliki pinjaman Bank dari Bankaltim sebanyak 1 lembar <i>(opsional)</i></li>
  </ol>

  <p>Demikian permohonan ini saya sampaikan, atas perhatian dan perkenan Bapak diucapkan terima kasih.</p>

  ${String(submission.mode_pemohon || 'OPD').toUpperCase() === 'UPTD' ? `
  <table class="signature signature-uptd">
    <tr class="top">
      <td>
        <b>Menyetujui :</b><br>
        <b>Kepala Puskesmas/Rumah Sakit/Sekolah</b><br>
        <i>(Pimpinan Pemohon)</i>
        <div class="sig-space">&nbsp;<br>&nbsp;<br>&nbsp;<br>&nbsp;<br>&nbsp;<br>&nbsp;<br>&nbsp;<br>&nbsp;</div>
        <div class="sig-line">(....................................................)</div>
      </td>
      <td class="right">
        Hormat Saya<br>
        <b>Pemohon,</b>
        <div class="sig-space">&nbsp;<br>&nbsp;<br>&nbsp;<br>&nbsp;<br>&nbsp;<br>&nbsp;<br>&nbsp;<br>&nbsp;</div>
        <b>${nama}</b><br>
        NIP. ${nip}
        <div class="footer-date">Ujoh Bilang, ${dateText}</div>
      </td>
    </tr>
    <tr class="bottom">
      <td colspan="2">
        <b>Mengetahui :</b><br>
        <b>Kepala Dinas/Badan</b><br>
        <i>(Pimpinan Pemohon)</i>
        <div class="sig-space">&nbsp;<br>&nbsp;<br>&nbsp;<br>&nbsp;<br>&nbsp;<br>&nbsp;</div>
        <div class="sig-line">(....................................................)</div>
      </td>
    </tr>
  </table>
  ` : `
  <table class="signature">
    <tr>
      <td class="left">
        <b>Mengetahui/Menyetujui :</b><br>
        <b>Kepala Dinas/Badan</b><br>
        <i>(Pimpinan Pemohon)</i>
        <div class="sig-space">&nbsp;<br>&nbsp;<br>&nbsp;<br>&nbsp;<br>&nbsp;<br>&nbsp;<br>&nbsp;<br>&nbsp;</div>
        <div class="sig-line">(....................................................)</div>
      </td>
      <td class="right">
        Hormat Saya<br>
        <b>Pemohon,</b>
        <div class="sig-space">&nbsp;<br>&nbsp;<br>&nbsp;<br>&nbsp;<br>&nbsp;<br>&nbsp;<br>&nbsp;<br>&nbsp;</div>
        <b>${nama}</b><br>
        NIP. ${nip}
        <div class="footer-date">Ujoh Bilang, ${dateText}</div>
      </td>
    </tr>
  </table>
  `}
  <div class="note">Dokumen ini dibuat otomatis dari Portal Pengajuan SKBT dan dapat diedit oleh pemohon melalui Google Docs.<br>${gmail ? `Akun edit: ${gmail}` : ''}</div>
</body></html>`;
}

// --------------------------------------------------------------------------
// EMAIL
// --------------------------------------------------------------------------
async function sendEmailNotification(env, submission, documents, docLinks) {
  if (!env.RESEND_API_KEY || !env.ADMIN_EMAIL) return;
  try {
    const docList = documents.map(d => `<li>${escapeHtml(d.nama_dokumen)} — ${escapeHtml(d.file_name)}</li>`).join('');
    const links = docLinks
      ? `<p><b>Form Google Docs:</b> <a href="${docLinks.editUrl}">Buka & Edit</a> | <a href="${docLinks.pdfUrl}">PDF</a> | <a href="${docLinks.docxUrl}">DOCX</a></p>`
      : '';

    const emailBody = `<div style="font-family:Arial,sans-serif;background:#f4f7fb;padding:20px;color:#172033">
      <h2 style="color:#174e49">Pengajuan SKBT Baru</h2>
      <p>Sebuah pengajuan baru telah difinalisasi. File sudah disalin ke Google Drive dan form surat tersedia di Google Docs.</p>
      <table style="width:100%;border-collapse:collapse">
        <tr><td style="padding:5px;font-weight:bold;width:170px">Nomor</td><td style="padding:5px">: ${escapeHtml(submission.nomor_pengajuan)}</td></tr>
        <tr><td style="padding:5px;font-weight:bold">Nama</td><td style="padding:5px">: ${escapeHtml(submission.nama_pemohon)}</td></tr>
        <tr><td style="padding:5px;font-weight:bold">NIP</td><td style="padding:5px">: ${escapeHtml(submission.nip || '-')}</td></tr>
        <tr><td style="padding:5px;font-weight:bold">Pangkat/Golongan</td><td style="padding:5px">: ${escapeHtml(submission.pangkat_golongan || '-')}</td></tr>
        <tr><td style="padding:5px;font-weight:bold">Jabatan</td><td style="padding:5px">: ${escapeHtml(submission.jabatan || '-')}</td></tr>
        <tr><td style="padding:5px;font-weight:bold">Unit Kerja</td><td style="padding:5px">: ${escapeHtml(submission.unit_kerja || '-')}</td></tr>
        <tr><td style="padding:5px;font-weight:bold">No. HP</td><td style="padding:5px">: ${escapeHtml(submission.nomor_hp || '-')}</td></tr>
        <tr><td style="padding:5px;font-weight:bold">Gmail</td><td style="padding:5px">: ${escapeHtml(submission.gmail || '-')}</td></tr>
        <tr><td style="padding:5px;font-weight:bold">Keperluan</td><td style="padding:5px">: ${escapeHtml(submission.keperluan || '-')}</td></tr>
      </table>
      <h3 style="color:#0077b6">Dokumen</h3><ul>${docList}</ul>
      ${links}
    </div>`;

    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'Pengajuan SKBT <onboarding@resend.dev>',
        to: env.ADMIN_EMAIL,
        subject: 'Pengajuan SKBT Baru: ' + submission.nomor_pengajuan,
        html: emailBody,
      }),
    });
  } catch (error) {
    console.error('Gagal kirim email admin:', error);
  }
}

// --------------------------------------------------------------------------
// MAIN HANDLER
// --------------------------------------------------------------------------
export const onRequest = async ({ request, env }) => {
  const url = new URL(request.url);
  let params = {};
  let action = url.searchParams.get('action') || '';

  if (request.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      },
    });
  }

  if (request.method === 'POST') {
    try {
      params = await request.json();
      if (!action && params.action) action = params.action;
    } catch (error) {
      return jsonResponse({ status: 'error', msg: 'Body JSON tidak valid.' }, 400);
    }
  } else {
    url.searchParams.forEach((value, key) => { params[key] = value; });
  }

  try {
    await ensureSchema(env);
    switch (action) {
      case 'submitPengajuan': {
        const {
          nama_pemohon, mode_pemohon, nip, pangkat_golongan, jabatan,
          unit_kerja, nomor_hp, gmail, keperluan,
        } = params;

        if (!nama_pemohon || !unit_kerja || !nomor_hp || !gmail || !keperluan) {
          return jsonResponse({ status: 'error', msg: 'Data wajib belum lengkap.' }, 400);
        }

        const nomor = 'SKBT-' + Date.now().toString().slice(-8) + '-' + Math.floor(1000 + Math.random() * 9000);
        const insert = await env.DB.prepare(
          `INSERT INTO skbt_submissions
          (nomor_pengajuan, nama_pemohon, mode_pemohon, nip, pangkat_golongan, jabatan, unit_kerja, nomor_hp, gmail, keperluan, status_verifikasi, current_level)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Draft', 1)`
        ).bind(
          nomor, nama_pemohon, ['UPTD','OPD'].includes(mode_pemohon) ? mode_pemohon : 'OPD', nip || '', pangkat_golongan || '', jabatan || '',
          unit_kerja, nomor_hp, gmail, keperluan || '',
        ).run();

        return jsonResponse({
          status: 'success',
          msg: 'Data pemohon tersimpan sebagai draft.',
          id: insert.meta.last_row_id,
          nomor_pengajuan: nomor,
        });
      }

      case 'uploadDocument': {
        const {
          submission_id, dokumen_code, nama_dokumen,
          file_name, file_data, nama_pemohon,
        } = params;

        if (!submission_id || !ALL_DOCUMENT_CODES.includes(dokumen_code) || !file_name || !file_data) {
          return jsonResponse({ status: 'error', msg: 'Data upload tidak lengkap.' }, 400);
        }

        const submission = await env.DB.prepare('SELECT id, nama_pemohon FROM skbt_submissions WHERE id = ?').bind(submission_id).first();
        if (!submission) return jsonResponse({ status: 'error', msg: 'Draft pengajuan tidak ditemukan.' }, 404);

        const { count } = await env.DB.prepare(
          'SELECT COUNT(*) AS count FROM skbt_documents WHERE submission_id = ? AND dokumen_code = ?'
        ).bind(submission_id, dokumen_code).first();

        if (Number(count) >= MAX_FILES_PER_DOCUMENT) {
          return jsonResponse({ status: 'error', msg: `Maksimal ${MAX_FILES_PER_DOCUMENT} file untuk dokumen ini.` }, 400);
        }

        const decoded = atob(file_data);
        const bytes = Uint8Array.from(decoded, c => c.charCodeAt(0));
        if (bytes.byteLength === 0) return jsonResponse({ status: 'error', msg: 'File kosong tidak dapat diupload.' }, 400);
        if (bytes.byteLength > MAX_FILE_SIZE) {
          return jsonResponse({ status: 'error', msg: 'File terlalu besar. Maksimal 5 MB per file.' }, 400);
        }

        const cleanName = safeFileName(file_name);
        const safeNama = safeFolderName(nama_pemohon || submission.nama_pemohon);
        const r2Path = `skbt/${submission_id}/${dokumen_code}/${safeNama}_${Date.now()}_${cleanName}`;
        const contentType = getContentType(cleanName);

        await env.EVIDENCE_BUCKET.put(r2Path, bytes, {
          httpMetadata: { contentType },
          customMetadata: {
            submissionId: String(submission_id),
            documentCode: dokumen_code,
            originalName: cleanName,
          },
        });

        const publicBase = env.R2_PUBLIC_BASE_URL || 'https://pub-68de0ab1691946469b18177ed5ce1404.r2.dev';
        const publicUrl = `${String(publicBase).replace(/\/$/, '')}/${r2Path}`;

        const insert = await env.DB.prepare(
          `INSERT INTO skbt_documents
          (submission_id, dokumen_code, nama_dokumen, file_name, file_url, r2_path, verification_status, verification_note, gdrive_id)
          VALUES (?, ?, ?, ?, ?, ?, 'pending', '', NULL)`
        ).bind(submission_id, dokumen_code, nama_dokumen, cleanName, publicUrl, r2Path).run();

        return jsonResponse({
          status: 'success',
          document_id: insert.meta.last_row_id,
          url: publicUrl,
          msg: 'File tersimpan sementara di R2. File akan disalin ke Google Drive saat pengajuan dikirim.',
        });
      }

      case 'finalizeSubmission': {
        const { submission_id } = params;
        if (!submission_id) return jsonResponse({ status: 'error', msg: 'submission_id wajib diisi.' }, 400);

        const sub = await env.DB.prepare('SELECT * FROM skbt_submissions WHERE id = ?').bind(submission_id).first();
        if (!sub) return jsonResponse({ status: 'error', msg: 'Pengajuan tidak ditemukan.' }, 404);

        const docsResult = await env.DB.prepare('SELECT * FROM skbt_documents WHERE submission_id = ? ORDER BY id ASC').bind(submission_id).all();
        const documents = docsResult.results || [];

        const missingRequired = REQUIRED_DOCUMENT_CODES.filter(code => !documents.some(d => d.dokumen_code === code));
        if (missingRequired.length) {
          return jsonResponse({
            status: 'error',
            msg: 'Dokumen wajib belum lengkap: ' + missingRequired.join(', '),
          }, 400);
        }

        const driveFolderId = await (async () => {
          const token = await getGoogleAccessToken(env);
          const folderName = safeFolderName(sub.nama_pemohon);
          return { token, folderId: await getOrCreateApplicantFolder(token, env.GOOGLE_DRIVE_FOLDER_ID, folderName, sub.gdrive_folder_id || null) };
        })();

        // Simpan folder ID lebih dulu agar retry tidak membuat folder baru.
        if (!sub.gdrive_folder_id || sub.gdrive_folder_id !== driveFolderId.folderId) {
          await env.DB.prepare('UPDATE skbt_submissions SET gdrive_folder_id = ? WHERE id = ?').bind(driveFolderId.folderId, submission_id).run();
        }

        // Penting: tidak ada file yang boleh dianggap selesai sebelum Drive berhasil.
        for (const doc of documents) {
          if (doc.gdrive_id) continue;

          const r2Path = doc.r2_path || (() => {
            if (!doc.file_url || !doc.file_url.includes('r2.dev/')) return '';
            return decodeURIComponent(doc.file_url.split('r2.dev/')[1]);
          })();
          if (!r2Path) throw new Error(`Path R2 untuk ${doc.file_name} tidak ditemukan.`);

          const object = await env.EVIDENCE_BUCKET.get(r2Path);
          if (!object) throw new Error(`File ${doc.file_name} tidak ditemukan di R2.`);
          const bytes = new Uint8Array(await object.arrayBuffer());
          if (bytes.byteLength > MAX_FILE_SIZE) throw new Error(`File ${doc.file_name} melebihi 5 MB.`);

          const driveFile = await uploadFileToGoogleDrive(
            driveFolderId.token,
            driveFolderId.folderId,
            doc.file_name,
            bytes,
            object.httpMetadata?.contentType || getContentType(doc.file_name),
          );

          if (!driveFile.id) throw new Error(`Google Drive tidak mengembalikan ID untuk ${doc.file_name}.`);
          await env.DB.prepare('UPDATE skbt_documents SET gdrive_id = ? WHERE id = ?').bind(driveFile.id, doc.id).run();
        }

        let docLinks = null;
        if (sub.gdocs_id) {
          docLinks = {
            id: sub.gdocs_id,
            editUrl: sub.gdocs_url || `https://docs.google.com/document/d/${sub.gdocs_id}/edit`,
            pdfUrl: sub.gdocs_pdf_url || `https://docs.google.com/document/d/${sub.gdocs_id}/export?format=pdf`,
            docxUrl: sub.gdocs_docx_url || `https://docs.google.com/document/d/${sub.gdocs_id}/export?format=docx`,
          };
        } else {
          const html = buildApplicationLetterHtml(sub);
          docLinks = await createGoogleDocFromHtml(
            driveFolderId.token,
            driveFolderId.folderId,
            `Surat Permohonan SKBT - ${safeFileName(sub.nama_pemohon)}`,
            html,
            sub.gmail,
          );

          await env.DB.prepare(
            `UPDATE skbt_submissions
             SET gdocs_id = ?, gdocs_url = ?, gdocs_pdf_url = ?, gdocs_docx_url = ?
             WHERE id = ?`
          ).bind(docLinks.id, docLinks.editUrl, docLinks.pdfUrl, docLinks.docxUrl, submission_id).run();
        }

        // Hanya setelah semua file R2 -> Drive dan Google Docs sukses, status berubah.
        await env.DB.prepare(
          `UPDATE skbt_submissions
           SET status_verifikasi = 'Menunggu Sekretaris Inspektorat', current_level = 1
           WHERE id = ?`
        ).bind(submission_id).run();

        await sendEmailNotification(env, sub, documents, docLinks);

        return jsonResponse({
          status: 'success',
          msg: 'Pengajuan berhasil dikirim. Seluruh dokumen sudah masuk Google Drive dan form surat tersedia di Google Docs.',
          nomor_pengajuan: sub.nomor_pengajuan,
          gdrive_folder_url: `https://drive.google.com/drive/folders/${driveFolderId.folderId}`,
          google_doc: docLinks,
          editor_access_granted: Boolean(docLinks.editorAccessGranted !== false),
        });
      }

      case 'getPengajuanById': {
        const { id } = params;
        const sub = await env.DB.prepare('SELECT * FROM skbt_submissions WHERE id = ?').bind(id).first();
        if (!sub) return jsonResponse({ status: 'error', msg: 'Pengajuan tidak ditemukan.' }, 404);
        const docs = await env.DB.prepare('SELECT * FROM skbt_documents WHERE submission_id = ? ORDER BY dokumen_code, id').bind(id).all();
        return jsonResponse({ status: 'success', submission: sub, documents: docs.results || [] });
      }

      case 'getAllPengajuan': {
        const { results } = await env.DB.prepare('SELECT * FROM skbt_submissions ORDER BY created_at DESC').all();
        return jsonResponse(results || []);
      }

      default:
        return jsonResponse({ status: 'error', msg: 'Aksi tidak dikenal.' }, 404);
    }
  } catch (error) {
    console.error('SKBT handler error:', error);
    return jsonResponse({ status: 'error', msg: 'Gagal memproses pengajuan: ' + error.message }, 500);
  }
};
