-- Jalankan SEKALI pada D1 database lama yang sudah memiliki tabel SKBT.
-- Sesuaikan dengan keadaan database Anda bila ada kolom yang sudah pernah dibuat.

ALTER TABLE skbt_submissions ADD COLUMN pangkat_golongan TEXT;
ALTER TABLE skbt_submissions ADD COLUMN nomor_hp TEXT;
ALTER TABLE skbt_submissions ADD COLUMN gmail TEXT;
ALTER TABLE skbt_submissions ADD COLUMN keperluan TEXT;
ALTER TABLE skbt_submissions ADD COLUMN catatan_sekretaris TEXT;
ALTER TABLE skbt_submissions ADD COLUMN catatan_inspektur TEXT;
ALTER TABLE skbt_submissions ADD COLUMN gdrive_folder_id TEXT;
ALTER TABLE skbt_submissions ADD COLUMN gdocs_id TEXT;
ALTER TABLE skbt_submissions ADD COLUMN gdocs_url TEXT;
ALTER TABLE skbt_submissions ADD COLUMN gdocs_pdf_url TEXT;
ALTER TABLE skbt_submissions ADD COLUMN gdocs_docx_url TEXT;

ALTER TABLE skbt_documents ADD COLUMN r2_path TEXT;
ALTER TABLE skbt_documents ADD COLUMN verification_status TEXT DEFAULT 'pending';
ALTER TABLE skbt_documents ADD COLUMN verification_note TEXT DEFAULT '';

-- Normalisasi status lama
UPDATE skbt_submissions SET status_verifikasi = 'Menunggu Sekretaris Inspektorat', current_level = 1 WHERE status_verifikasi IN ('Menunggu Irban', 'Menunggu Verifikasi Irban');
