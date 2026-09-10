-- ============================================================================
-- SKBT DATABASE SCHEMA V3.1
-- Untuk database lama, jalankan migration_v3.sql sekali. Database baru bisa langsung memakai schema ini.
-- ============================================================================

CREATE TABLE IF NOT EXISTS skbt_submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nomor_pengajuan TEXT UNIQUE,
  nama_pemohon TEXT NOT NULL,
  mode_pemohon TEXT DEFAULT 'OPD',
  nip TEXT,
  pangkat_golongan TEXT,
  jabatan TEXT,
  unit_kerja TEXT,
  nomor_hp TEXT,
  gmail TEXT,
  keperluan TEXT,
  tanggal_pengajuan TEXT DEFAULT CURRENT_TIMESTAMP,
  status_verifikasi TEXT DEFAULT 'Draft',
  current_level INTEGER DEFAULT 1,
  catatan_sekretaris TEXT,
  catatan_inspektur TEXT,
  gdrive_folder_id TEXT,
  gdocs_id TEXT,
  gdocs_url TEXT,
  gdocs_pdf_url TEXT,
  gdocs_docx_url TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS skbt_documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  submission_id INTEGER NOT NULL,
  dokumen_code TEXT NOT NULL,
  nama_dokumen TEXT NOT NULL,
  file_name TEXT,
  file_url TEXT,
  r2_path TEXT,
  gdrive_id TEXT,
  verification_status TEXT DEFAULT 'pending',
  verification_note TEXT DEFAULT '',
  uploaded_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(submission_id) REFERENCES skbt_submissions(id)
);

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

CREATE INDEX IF NOT EXISTS idx_skbt_documents_submission ON skbt_documents(submission_id);
CREATE INDEX IF NOT EXISTS idx_skbt_documents_code ON skbt_documents(submission_id, dokumen_code);
CREATE INDEX IF NOT EXISTS idx_skbt_submissions_status ON skbt_submissions(status_verifikasi);
