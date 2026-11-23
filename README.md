# DocuSign Embedded Sender Test App

Creates a draft envelope via the eSignature REST API, requests a sender view URL,
and loads it in an iframe.

## Setup

1. Fill in the values in `.env` from your DocuSign developer integration.
2. Save the RSA private key to `keys/private.key`.
3. Grant consent once (replace YOUR_INTEGRATION_KEY):
   https://account-d.docusign.com/oauth/auth?response_type=code&scope=signature%20impersonation&client_id=YOUR_INTEGRATION_KEY&redirect_uri=http://localhost:3000/
4. Install and run:

       npm install
       npm start

5. Open http://localhost:3000
