# User Details Middleware (For Alankit)

Node.js middleware service for storing GST user bank details and generating invoice PDF media from IRN invoice responses.

## Features

- Store user details by GSTIN.
- Fetch user details by GSTIN.
- Generate invoice PDFs from signed invoice payloads.
- Serve generated PDF files from the `uploads` directory.
- MongoDB storage using Mongoose.

## Tech Stack

- Node.js
- Express.js
- MongoDB / Mongoose
- PDFKit
- QRCode
- PM2 for production process management

## Project Structure

```text
.
├── app.js
├── server.js
├── package.json
├── src
│   ├── config
│   ├── controllers
│   ├── middleware
│   ├── models
│   ├── routes
│   ├── services
│   └── utils
└── uploads
```

## Environment Variables

Create an environment-specific file in the project root.

- `.env.development`
- `.env.production`

Example:

```env
APP_ENV=development
PORT=5000
HOST=localhost
MONGODB_URI=mongodb://localhost:27017
MONGODB_DB=AlankitUserDetails
```

Production should use `APP_ENV=production` and `MONGODB_DB=AlankitUserDetails_Production`.


## Local Setup

Install dependencies:

```bash
npm install
```

Start in development mode:

```bash
npm run dev
```

Start normally:

```bash
npm start
```

Run lint:

```bash
npm run lint
```

## API Endpoints

### Create User Details

```http
POST /user-details
```

Request body:

```json
{
  "Gstin": "07ABCDE1234F1Z5",
  "UserName": "Example User",
  "Password": "secret123",
  "LogoS3Url": "https://example-bucket.s3.amazonaws.com/logos/example.png",
  "BankDetails": {
    "BankName": "Example Bank",
    "AccountNumber": "123456789012",
    "IFSCCode": "ABCD0123456",
    "UPIID": "example@upi"
  }
}
```

Success response:

```json
{
  "Status": "OK",
  "Message": "User Entered Successfully",
  "UserId": "generated-user-id"
}
```

### Get User Details

```http
GET /user-details/:gstin
```

Example:

```bash
curl http://localhost:5000/user-details/07ABCDE1234F1Z5
```

### Generate Invoice PDF

```http
POST /api/invoice/generate
```

Request body:

```json
{
  "LogoS3Url": "https://example-bucket.s3.amazonaws.com/logos/example.png",
  "invoiceResponse": {
    "AckNo": "123456789",
    "AckDt": "2026-05-18",
    "Irn": "invoice-reference-number",
    "SignedInvoice": "signed-invoice-token",
    "SignedQRCode": "signed-qr-code-token",
    "Status": "ACT"
  }
}
```

Success response:

```json
{
  "status": true,
  "message": "Invoice PDF generated successfully",
  "mediaUrl": "http://localhost:5000/uploads/invoices/invoice_123456789.pdf",
  "fileName": "invoice_123456789.pdf"
}
```

## Notes

- Generated invoice PDFs are stored in `uploads/invoices`.
- The `uploads` folder must be writable by the user running the Node.js process.
- GSTIN, IFSC, account number, and UPI ID are validated before user details are saved.

## Registration throughput and uniqueness

`POST /user-details` uses one MongoDB insert. Separate database unique indexes protect
`Gstin`, `MobileNumber`, and `InvoiceSeries`, including simultaneous requests. There
is no preliminary duplicate lookup. A conflict returns HTTP 409 with
`Code: DUPLICATE_USER_DETAILS` and a `Fields` array identifying the conflicting field.
Invoice-series updates use the same database constraint. Series comparisons are
case insensitive (`ABC1` and `abc1` conflict). GSTINs are trimmed and uppercased;
mobile numbers are trimmed. GSTIN and series remain optional; supplied values must
be unique across users. History entries do not reserve old series permanently.

On startup the API verifies the required unique indexes before accepting requests.
If existing duplicates prevent index creation, startup fails without deleting or
rewriting records. To audit the configured development database manually:

```bash
node scripts/audit-user-uniqueness.cjs
node scripts/audit-user-uniqueness.cjs --apply
```

Registration stores the supplied `LogoS3Url` directly. It does not fetch the logo,
write a logo file, or replace the URL with a local upload path. Invoice generation
fetches remote logos into memory and caches up to 32 normalized PNG buffers for five
minutes (unavailable logos for five seconds). PDF logos are converted through
stdin/stdout, without temporary files. Interrupted downloads reject and the entire
redirect chain has a 10-second deadline. Existing local logo references remain
readable. Generated invoice PDF files still use the existing invoice storage paths.
The in-memory cache is local to each Node process.

Optional environment settings:

```env
REGISTRATION_MAX_INFLIGHT=200
REGISTRATION_RATE_LIMIT_RPS=0
MONGO_MAX_POOL_SIZE=100
```

The concurrency cap includes registration work whose client already disconnected.
Excess work receives HTTP 503 `REGISTRATION_BUSY` and `Retry-After: 1`, before a
write is started. The optional rate cap returns HTTP 429; zero disables it. These
limits apply per Node process, so account for all workers sharing one database.
They protect the app; they do not increase the Atlas cluster's capacity.

Database connection selection and pool waiting are bounded at five seconds. These
are not a deadline on an insert already sent to MongoDB. A network/database timeout
can leave a write outcome unknown; a 503 `DATABASE_UNAVAILABLE` response indicates
this with `WriteOutcomeUnknown`. Check `GET /user-details/mobile/:mobileNumber`
before retrying an ambiguous registration. Unique indexes prevent retries from
creating duplicate users. Shutdown drains HTTP and registration work before closing
MongoDB, with a 30-second final drain limit.

### Tests and local artifacts

```bash
npm test
npm run lint
```

The regression suite uses an isolated local MongoDB database and removes only that
test database when finished. PDF-logo conversion tests require `pdftoppm` (Poppler).
Logo images and PDF logos are processed in memory; only generated invoice PDFs use
the existing invoice storage directories.

Local load-test helpers and reports under `diagnostics/` are intentionally excluded
from Git. They are optional and are not required to run the API or regression tests.
Dependencies, actual environment files, local database data, logs, generated uploads,
and editor settings are ignored. Commit `.env.example` and `package-lock.json`;
create `.env.development` or `.env.production` locally before starting the API.
