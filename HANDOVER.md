# Handover: Lori AI (Slack bot + Salesforce)

Dibuat 2026-10-09. Ditulis untuk AI yang melanjutkan pekerjaan ini di sesi/project lain. Baca bagian "Cara bekerja dengan user" dan "Status & hal yang belum terverifikasi" dulu.

## Cara bekerja dengan user (Alek)
- Balas dalam **Bahasa Indonesia**, singkat dan langsung.
- Kata "push" = commit semua perubahan yang relevan lalu `git push origin alek_timesheet`. Akhiri commit message dengan baris Co-Authored-By sesuai instruksi sesi.
- Pekerjaan demo/presales: **jangan buat test** (Jest/Apex test) dan utamakan solusi **tanpa Apex** (Flow, LWC dengan uiRecordApi/GraphQL, konfigurasi deklaratif). Kalau Apex benar-benar perlu, jelaskan dulu konsekuensi coverage 75%, jangan otomatis menulis test.
- Jangan menebak nama field/object Salesforce. Minta API name, atau baca dari describe.

## Apa ini
Slack app "Lori AI" (LangitKreasi Orchestrated Reasoning Intelligence) untuk LKS. Chat di DM/panel Assistant atau @mention di channel; AI (OpenAI function calling) bisa query/edit Salesforce, menganalisis opportunity, mencatat aktivitas, dan membaca channel Slack. Ada juga alur lama /timesheet-lks dan /leaverequest-lks yang kirim ke Apex REST Salesforce.

- Repo: `/Users/aleknurfatman/Downloads/LKS/Project/slack/suplo-ai/suploai_slack` (GitHub `aleknf/suploai_slack`), branch **alek_timesheet**, push terakhir commit `415ce9c`. Cek `git status` dulu: beberapa file (reviewBlocks.js, progress.js, recordBlocks.js) tercatat berubah di disk setelah push, isi perubahannya tidak diketahui.
- Stack: Node, `@slack/bolt` 4.2.0 (socket mode), `@slack/web-api` 7.8.0, `openai` ^4.85, `node-fetch` 2. Model **gpt-4o-mini** (hardcoded di `app.js` pada `runWithTools`). Salesforce REST v59.0, login username-password OAuth satu akun service. Jalankan: `npm ci && npm start`.
- Env (`.env`, contoh di `.env.sample`): SLACK_BOT_TOKEN, SLACK_APP_TOKEN, SLACK_USER_TOKEN, SLACK_TIMESHEET_CHANNEL, OPENAI_API_KEY, SALESFORCE_CLIENT_ID, SALESFORCE_CLIENT_SECRET, SALESFORCE_USER_NAME, SALESFORCE_USER_PASS. Opsional: SF_URL, SF_CURRENCY (default IDR), DISPLAY_TZ (default Asia/Jakarta). `sfUrl` default = org produksi `https://langitkreasisolusindo.my.salesforce.com` (juga hardcoded di app.js).

## Peta file
| File | Isi |
|---|---|
| `app.js` | Handler Slack (Assistant, app_mention, member_joined_channel, tombol/modal), loop AI `runWithTools`, system prompt `DEFAULT_SYSTEM_CONTENT`, `buildReplyMessage`, alur timesheet/leave lama |
| `salesforce.js` | REST helper: runSOQL/SOSL, describe (cache 10 menit), get/create/update/deleteRecord, `getOpportunityInsights`, `findUserIdByEmail`, `getClosedTaskStatus`, `htmlToText` |
| `sfTools.js` | Skema tool OpenAI + `executeTool`: describe_salesforce_object, query_records, search_records, get_record_details, get_case_details, query_cases, get_activity_history, analyze_opportunity, log_activity, update_record |
| `slackTools.js` | read_channel_history (maks 50 pesan, cek membership untuk channel private), join_channel |
| `recordBlocks.js` | Kartu record Block Kit, kartu konfirmasi edit, modal Edit, parser submit modal |
| `reviewBlocks.js` | Kartu "Opportunity Review" terstruktur + tool `present_opportunity_review` |
| `activityBlocks.js` | Kartu "Aktivitas dicatat" + Undo |
| `fileTools.js` | Tool `read_file` (link Google Drive/Docs/Sheets/Slides → teks) dan `disconnect_google_drive`; routing per tipe file |
| `googleAuth.js` | OAuth Google per user Slack: state bertanda tangan, token terenkripsi (AES-256-GCM, `data/google-tokens.json`), refresh, server callback HTTP |
| `progress.js` | Animasi membaca/berpikir (status Assistant; placeholder + reaksi 👀/✅ di channel) |
| `manifest.json` | Scope, event, slash command |

## Perilaku kunci
- Pencarian record **tanpa konfirmasi object**; AI menebak object. Hasil query tampil sebagai kartu (maks 8 field per kartu, hanya field yang di-SELECT AI).
- Edit: lewat chat → kartu konfirmasi Save/Cancel (hanya peminta yang bisa klik); lewat tombol ✏️ Edit → modal (field yang tampil di kartu saja, hanya field berubah yang disimpan).
- `analyze_opportunity` → AI dipaksa memanggil `present_opportunity_review` → kartu review (KPI dihitung kode, bukan AI). Tombol "➕ Buat Task" per next action (`sf_create_task`).
- `log_activity`: langsung membuat Task Completed (owner = user Salesforce yang cocok dengan email Slack, fallback akun service) + tombol Undo (`sf_undo_task`).
- Field Discovery Opportunity yang selalu diambil: Salesforce_Implementation_Objective__c, Current_Tools__c, Integration__c, Expected_Impact__c, Implementation_Timeline__c, Standard_Business_Process__c, Quip_Link__c, Discovery_Check__c (plus deteksi otomatis field/object yang namanya mengandung "discovery").
- action_id: sf_edit_record, sf_confirm_edit, sf_cancel_edit, sf_create_task, sf_undo_task, sf_open_record; callback_id modal: sf_edit_modal.

## Membaca file dari link Google Drive (2026-10-18)
- Alur: user minta isi file/link → AI memanggil `read_file`. Belum terhubung → tombol "Hubungkan Google Drive" dikirim **ephemeral** (di DM assistant: inline). Setelah OAuth, Lori membaca dengan hak akses Google user itu sendiri (scope `drive.readonly`).
- Routing: Google Docs → export markdown; Sheets/Slides → export xlsx/pptx lalu **MarkItDown** (fallback: CSV sheet pertama / teks); docx/pptx/xlsx/html/epub → **MarkItDown** CLI (docx fallback mammoth); txt/md/csv/json/xml → dibaca langsung; **PDF** → teks lokal dulu (MarkItDown `[pdf]`, cadangan pdf-parse), **vision OpenAI** (PDF sebagai file input, panggilan terpisah) hanya bila `use_vision=true` atau PDF tanpa lapisan teks (scan).
- `pdf-parse` 1.1.1 gagal pada sebagian PDF modern ("bad XRef entry"), karena itu bukan jalur utama. Fixture `tests/fixtures/sample.{docx,pdf}` hanya file teks, bukan dokumen asli.
- Env baru: GOOGLE_CLIENT_ID/SECRET/REDIRECT_URI/TOKEN_KEY (+ opsional GOOGLE_ALLOWED_DOMAIN, OAUTH_PORT), lihat `.env.sample`. Server callback butuh URL HTTPS publik (reverse proxy ke port OAUTH_PORT). Server: `pip install "markitdown[pdf,docx,pptx,xlsx]"` (Python 3.10+).
- Diuji hanya dengan mock Google/OpenAI + dokumen sungguhan lokal; belum dengan Google Cloud project dan Slack asli.
- Risiko: isi file bisa memuat prompt injection. System prompt melarang mengikuti instruksi di file; `update_record` tetap perlu konfirmasi, tetapi `log_activity` langsung menyimpan.

## Status & hal yang belum terverifikasi
- **Semua fitur diuji hanya dengan mock** (Slack/Salesforce/OpenAI tiruan) + sintaks + lint. Belum ada uji di Slack dan org Salesforce asli.
- Manifest harus di-update di api.slack.com dan app di-reinstall untuk scope/event baru: `channels:join`, `channels:read`, `groups:read`, `mpim:history`, `mpim:read`, `reactions:write`, event `member_joined_channel`. Tanpa ini, join/baca channel dan reaksi tidak jalan.
- Akun service Salesforce perlu hak: baca/buat/hapus Task, assign Task ke user lain, baca User dan TaskStatus.

## Masalah yang sedang dikerjakan (di luar kode bot)
User menghubungkan record Salesforce ke channel lewat **integrasi bawaan Salesforce-Slack** (tab "Project details"). Field custom **`Jira_URL__c` (label "Drive Url")** pada object Project tidak muncul di tab itu. Ini **bukan** tampilan kartu bot Lori.
- Tab menampilkan: Project Name, Project Account, Status, Actual Start, Actual End, Planned Start, Planned End, SPK.
- Compact Layout "Custom Compact Project" (API `Custom_Compact_Project`, diubah 09/10/2026 oleh Operation Team) berisi: Project Name, SPK, Status, ORG ID, Planned Start, Planned End, Project Type, Drive Url. **Tidak cocok** dengan isi tab, jadi tab tidak memakai compact layout ini.
- Hipotesis (belum terbukti): (1) tab mengambil field dari bagian atas Page Layout Project, (2) ada Slack Record Layout tipe View untuk object tersebut. Dokumentasi resmi tidak menyebut sumber persisnya; dokumentasi Slack Record Layout hanya menyebut Account, Opportunity, Lead, Case, Contact, sedangkan dukungan custom object ada di halaman Object-Level Support.
- Langkah berikut yang ditawarkan ke user (belum dijawab): baca layout Project lewat REST `describe/layouts` dengan akun service (read-only) untuk melihat sumber sebenarnya. API name object kemungkinan `Project__c` (verifikasi dulu).

## Rekomendasi yang belum dikerjakan
1. **Pembatasan hak akses edit** (paling penting): semua query/edit/log memakai satu akun service sehingga siapa pun di workspace bisa mengubah record apa pun. Usulan: cocokkan email Slack ke User Salesforce, izinkan edit hanya untuk owner/role tertentu, catat audit.
2. SOQL injection di `queryCases` dan `getActivityHistory` (salesforce.js): input belum di-escape; helper `escapeSoql` sudah ada.
3. Cache token Salesforce (sekarang login baru di setiap panggilan; satu analisis oppty bisa 6-8 login).
4. Model dari env (`OPENAI_MODEL`); gpt-4o-mini kadang kurang andal untuk alur bertahap.
5. Daftar "field default per object" (field custom selalu masuk query, kartu, dan modal Edit) untuk kartu bot Lori.
6. Fitur lanjutan: alert proaktif mingguan, unfurl link Salesforce, briefing meeting, App Home dashboard, lanjut di thread tanpa mention ulang.

## Sisa-sisa lama
- `/set-model` dan `/current-model` ada di manifest tapi tidak punya handler.
- `tests/fileProcessing.test.js` rusak sejak sebelum perubahan (mengimpor fungsi yang sudah tidak ada; jest gagal dengan `defaults` undefined). Jangan perbaiki untuk pekerjaan demo kecuali diminta.
- `getSalesforceToken` dan `sfUrl` terduplikasi di app.js dan salesforce.js. Lint biome punya beberapa error lama di app.js (kode timesheet/leave); hindari menambah yang baru.
