-- Tabel Pengajuan SKBT
CREATE TABLE IF NOT EXISTS skbt_submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nomor_pengajuan TEXT UNIQUE,
  nama_pemohon TEXT NOT NULL,
  nip TEXT,
  jabatan TEXT,
  unit_kerja TEXT,
  tanggal_pengajuan TEXT DEFAULT CURRENT_TIMESTAMP,
  status_verifikasi TEXT DEFAULT 'Menunggu Verifikasi Irban',
  current_level INTEGER DEFAULT 1,
  catatan_irban TEXT,
  catatan_inspektur TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Tabel detail dokumen yang diupload
CREATE TABLE IF NOT EXISTS skbt_documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  submission_id INTEGER,
  dokumen_code TEXT NOT NULL,
  nama_dokumen TEXT NOT NULL,
  file_name TEXT,
  file_url TEXT,
  gdrive_id TEXT,
  uploaded_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(submission_id) REFERENCES skbt_submissions(id)
);

-- Tabel riwayat verifikasi
CREATE TABLE IF NOT EXISTS skbt_verification_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  submission_id INTEGER,
  level_verifikasi INTEGER,
  verifier_name TEXT,
  status TEXT,
  catatan TEXT,
  verified_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(submission_id) REFERENCES skbt_submissions(id)
);
