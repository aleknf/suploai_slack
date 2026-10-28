/**
 * channelBlocks.js
 *
 * Confirmation cards for canvas and list writes. Nothing is saved until the requester clicks Save.
 */

const OP_LABEL = {
  insert_at_end: 'Tambah di akhir canvas',
  insert_at_start: 'Tambah di awal canvas',
  insert_after: 'Sisipkan setelah section',
  insert_before: 'Sisipkan sebelum section',
  replace_section: 'Ganti isi section',
  replace_all: 'Ganti SELURUH isi canvas',
  delete_section: 'Hapus section',
  rename: 'Ubah judul canvas',
};

const esc = text => String(text ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const truncate = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const quote = text => `>${esc(truncate(text, 900)).replace(/\n/g, '\n>')}`;

function buttons(id, requesterId) {
  const value = JSON.stringify({ id, u: requesterId });
  return {
    type: 'actions',
    block_id: `pending_${id}`,
    elements: [
      { type: 'button', text: { type: 'plain_text', text: 'Save' }, style: 'primary', action_id: 'pending_confirm', value },
      { type: 'button', text: { type: 'plain_text', text: 'Cancel' }, action_id: 'pending_cancel', value },
    ],
  };
}

/**
 * Builds the confirmation card of a pending canvas/list write.
 *
 * @param {string} id - Id returned by pending.put()
 * @param {Object} entry - The pending entry
 * @returns {Object[]} Blocks
 */
function buildPendingBlocks(id, entry) {
  const lines = [];

  if (entry.kind === 'canvas_edit') {
    lines.push(`✏️ *Konfirmasi ubah canvas* — *${esc(entry.canvasName)}*`, `*${OP_LABEL[entry.op] || entry.op}*`);
    if (entry.sectionText) lines.push(`Target: _"${esc(truncate(entry.sectionText, 120))}"_`);
    if (entry.currentExcerpt) lines.push('*Isi saat ini (perkiraan):*', quote(entry.currentExcerpt));
    if (entry.op === 'rename') lines.push('*Judul baru:*', quote(entry.title));
    else if (entry.op !== 'delete_section') lines.push('*Isi baru:*', quote(entry.markdown));
    if (entry.op === 'replace_all' || entry.op === 'delete_section') {
      lines.push('⚠️ _Perubahan ini tidak bisa dibatalkan dari Slack._');
    }
  } else {
    const isAdd = entry.action === 'add_row';
    lines.push(`✏️ *Konfirmasi ${isAdd ? 'tambah baris' : 'ubah baris'} list* — *${esc(entry.listName)}*`);
    if (!isAdd && entry.rowLabel) lines.push(`Baris: _${esc(truncate(entry.rowLabel, 100))}_`);
    for (const change of entry.changes) {
      lines.push(
        isAdd
          ? `• *${esc(change.column)}*: ${esc(truncate(change.after, 200))}`
          : `• *${esc(change.column)}*: ${esc(truncate(change.before || '—', 100))} → *${esc(truncate(change.after, 200))}*`
      );
    }
  }

  return [
    { type: 'section', text: { type: 'mrkdwn', text: truncate(lines.join('\n'), 2990) } },
    buttons(id, entry.requesterId),
  ];
}

module.exports = { buildPendingBlocks, OP_LABEL };
