require('dotenv').config();
const path = require('path');
const fs = require('fs');
const express = require('express');
const docusign = require('docusign-esign');

const {
  DS_INTEGRATION_KEY,
  DS_USER_ID,
  DS_ACCOUNT_ID,
  DS_AUTH_SERVER = 'account-d.docusign.com',
  DS_PRIVATE_KEY_PATH = './keys/private.key',
  PORT = 3000,
} = process.env;

const SCOPES = ['signature', 'impersonation'];
let authCache = null;

/**
 * Obtains (and caches) a JWT access token, resolves the account's base URI.
 */
async function getAuth() {
  if (authCache && authCache.expiresAt > Date.now() + 60_000) return authCache;

  const privateKey = fs.readFileSync(path.resolve(DS_PRIVATE_KEY_PATH));

  const oauthClient = new docusign.ApiClient();
  oauthClient.setOAuthBasePath(DS_AUTH_SERVER);

  let tokenRes;
  try {
    tokenRes = await oauthClient.requestJWTUserToken(
      DS_INTEGRATION_KEY,
      DS_USER_ID,
      SCOPES,
      privateKey,
      3600
    );
  } catch (err) {
    if (err.response?.body?.error === 'consent_required') {
      const redirect = encodeURIComponent(`http://localhost:${PORT}/`);
      const consentUrl =
        `https://${DS_AUTH_SERVER}/oauth/auth?response_type=code` +
        `&scope=signature%20impersonation&client_id=${DS_INTEGRATION_KEY}` +
        `&redirect_uri=${redirect}`;
      throw new Error(`Consent required. Open this URL once and approve: ${consentUrl}`);
    }
    throw err;
  }

  const accessToken = tokenRes.body.access_token;
  const userInfo = await oauthClient.getUserInfo(accessToken);

  const account =
    (DS_ACCOUNT_ID
      ? userInfo.accounts.find((a) => a.accountId === DS_ACCOUNT_ID)
      : userInfo.accounts.find((a) => a.isDefault)) ?? userInfo.accounts[0];

  if (!account) throw new Error('No DocuSign account found for this user.');

  authCache = {
    accessToken,
    accountId: account.accountId,
    basePath: `${account.baseUri}/restapi`,
    expiresAt: Date.now() + tokenRes.body.expires_in * 1000,
  };
  return authCache;
}

/**
 * Returns an ApiClient pre-configured for the account, plus the account ID.
 */
async function getClient() {
  const auth = await getAuth();
  const client = new docusign.ApiClient();
  client.setBasePath(auth.basePath);
  client.addDefaultHeader('Authorization', `Bearer ${auth.accessToken}`);
  return { client, accountId: auth.accountId };
}

const app = express();
app.use(express.json({ limit: '25mb' }));
app.use(express.static(path.join(__dirname, 'public')));

/**
 * POST /api/envelopes
 * Creates a DRAFT envelope (status "created") with the uploaded document and one signer.
 * No tabs are added: the sender places them in the embedded sender view.
 */
app.post('/api/envelopes', async (req, res, next) => {
  try {
    const { fileName, fileBase64, signerName, signerEmail, emailSubject } = req.body;

    if (!fileBase64 || !signerName || !signerEmail) {
      return res.status(400).json({ error: 'fileBase64, signerName and signerEmail are required' });
    }

    const { client, accountId } = await getClient();
    const envelopesApi = new docusign.EnvelopesApi(client);

    const name = fileName || 'document.pdf';
    const envelopeDefinition = {
      emailSubject: emailSubject || 'Please review and sign',
      documents: [
        {
          documentBase64: fileBase64,
          name,
          fileExtension: name.split('.').pop().toLowerCase(),
          documentId: '1',
        },
      ],
      recipients: {
        signers: [
          {
            email: signerEmail,
            name: signerName,
            recipientId: '1',
            routingOrder: '1',
          },
        ],
      },
      status: 'created', // draft: stays unsent until the sender finishes in the iframe
    };

    const result = await envelopesApi.createEnvelope(accountId, { envelopeDefinition });
    res.json({ envelopeId: result.envelopeId, status: result.status });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/envelopes/:envelopeId/sender-view
 * Returns a one-time embedded sender URL to load in the iframe.
 */
app.post('/api/envelopes/:envelopeId/sender-view', async (req, res, next) => {
  try {
    const { client, accountId } = await getClient();
    const envelopesApi = new docusign.EnvelopesApi(client);

    const returnUrl =
      `${req.protocol}://${req.get('host')}/docusign/return` +
      `?envelopeId=${encodeURIComponent(req.params.envelopeId)}`;

    // Call the REST endpoint directly. The SDK's createSenderView maps only its
    // own option keys into the request body, so the settings object was dropped.
    const auth = await getAuth();
    const url =
      `${auth.basePath}/v2.1/accounts/${accountId}` +
      `/envelopes/${encodeURIComponent(req.params.envelopeId)}/views/sender`;

    const body = {
      returnUrl,
      viewAccess: 'envelope',
      settings: {
        startingScreen: 'Tagger',
        showBackButton: 'false',
        recipientSettings: {
          showEditRecipients: 'false',
        },
      },
    };

    const dsRes = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${auth.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    const data = await dsRes.json().catch(() => ({}));
    if (!dsRes.ok) {
      const err = new Error(data.message || `Sender view failed (HTTP ${dsRes.status})`);
      err.status = dsRes.status;
      err.response = { body: data };
      throw err;
    }

    res.json({ url: data.url });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /docusign/return
 * DocuSign redirects here when the sender finishes or cancels.
 * Notifies the parent page via postMessage. Does not echo query params into HTML.
 */
app.get('/docusign/return', (req, res) => {
  const event = String(req.query.event || 'unknown');
  const envelopeId = String(req.query.envelopeId || '');

  res.type('html').send(`<!doctype html>
<html><body>
<p>Returned from DocuSign. This window can be closed.</p>
<script>
  window.parent.postMessage(
    { source: 'docusign-return', event: ${JSON.stringify(event)}, envelopeId: ${JSON.stringify(envelopeId)} },
    window.location.origin
  );
</script>
</body></html>`);
});

/**
 * GET /api/envelopes/:envelopeId
 * Returns the current envelope status.
 */
app.get('/api/envelopes/:envelopeId', async (req, res, next) => {
  try {
    const { client, accountId } = await getClient();
    const envelopesApi = new docusign.EnvelopesApi(client);
    const env = await envelopesApi.getEnvelope(accountId, req.params.envelopeId);
    res.json({
      envelopeId: env.envelopeId,
      status: env.status,
      emailSubject: env.emailSubject,
      statusChangedDateTime: env.statusChangedDateTime,
    });
  } catch (err) {
    next(err);
  }
});

// Error handler
app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({
    error: err.message,
    details: err.response?.body,
  });
});

app.listen(PORT, () => {
  console.log(`Test app running at http://localhost:${PORT}`);
});
