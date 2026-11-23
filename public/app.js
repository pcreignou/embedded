const $ = (id) => document.getElementById(id);
let currentEnvelopeId = null;

function log(message, data) {
  const time = new Date().toLocaleTimeString();
  const body = data ? '\n' + JSON.stringify(data, null, 2) : '';
  $('log').textContent = `[${time}] ${message}${body}\n\n` + $('log').textContent;
}

function readAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(',')[1]); // strip data-URL prefix
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

async function postJson(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

async function refreshStatus() {
  if (!currentEnvelopeId) return;
  try {
    const res = await fetch(`/api/envelopes/${currentEnvelopeId}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || res.statusText);
    log('Envelope status', data);
  } catch (err) {
    log('ERROR refreshing status: ' + err.message);
  }
}

$('envForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const file = $('file').files[0];
    log(`Reading ${file.name}...`);
    const fileBase64 = await readAsBase64(file);

    const env = await postJson('/api/envelopes', {
      fileName: file.name,
      fileBase64,
      signerName: $('signerName').value,
      signerEmail: $('signerEmail').value,
      emailSubject: $('emailSubject').value,
    });

    currentEnvelopeId = env.envelopeId;
    $('refreshBtn').disabled = false;
    log('Draft envelope created', env);

    const view = await postJson(`/api/envelopes/${env.envelopeId}/sender-view`);
    log('Sender view URL received. Loading in iframe.');
    $('senderFrame').style.display = '';
    $('closeBtn').disabled = false;
    $('senderFrame').src = view.url;
  } catch (err) {
    log('ERROR: ' + err.message);
  }
});

$('refreshBtn').addEventListener('click', refreshStatus);

const ALLOWED_EVENTS = ['send', 'save', 'cancel', 'error', 'sessionEnd'];

/** Hides and unloads the sender iframe. */
function closeSenderFrame() {
  const frame = $('senderFrame');
  frame.src = 'about:blank';
  frame.style.display = 'none';
  $('closeBtn').disabled = true;
  log('Sender iframe closed');
}

// Receive the return notification from /docusign/return
window.addEventListener('message', (e) => {
  // 1. Only accept messages from this app's own origin (the return page is served by it)
  if (e.origin !== window.location.origin) return;

  // 2. Only accept messages from our sender iframe, not any other window
  if (e.source !== $('senderFrame').contentWindow) return;

  // 3. Validate the message shape and contents
  const d = e.data;
  if (!d || d.source !== 'docusign-return') return;
  if (d.envelopeId !== currentEnvelopeId) {
    log('Ignored return message for a different envelope', d);
    return;
  }
  if (!ALLOWED_EVENTS.includes(d.event)) {
    log('Ignored return message with unknown event', d);
    return;
  }

  // 4. Valid completion: close the iframe and refresh the envelope status
  log(`Sender view completed. Event: ${d.event}`, d);
  closeSenderFrame();
  refreshStatus();
});

$('closeBtn').addEventListener('click', closeSenderFrame);
