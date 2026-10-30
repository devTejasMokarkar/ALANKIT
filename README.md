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
Logo images and PDF logos are processed in memory. New IRN invoice PDFs are
generated in memory and stored in Cloudinary; tax invoices still use their existing
local storage directory.

Local load-test helpers and reports under `diagnostics/` are intentionally excluded
from Git. They are optional and are not required to run the API or regression tests.
Dependencies, actual environment files, local database data, logs, generated uploads,
and editor settings are ignored. Commit `.env.example` and `package-lock.json`;
create `.env.development` or `.env.production` locally before starting the API.

### Cloudinary invoice storage

`POST /user-details/invoice/generate` uploads PDF bytes directly to Cloudinary as
raw assets. Set `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, and
`CLOUDINARY_API_SECRET` in the environment file used by the server, or supply
`CLOUDINARY_URL=cloudinary://API_KEY:API_SECRET@CLOUD_NAME`. Keep these credentials
on the server. Restart the API after changing environment settings.

Successful generation returns the HTTPS Cloudinary URL in `mediaUrl`. Invoice
metadata remains in MongoDB. New files use UUID names and are never written to
`uploads/invoices`; upload failures return 502 without falling back to disk.
Invoice lists and ZIP downloads support both new cloud files and existing local
files. Existing PDFs are not migrated. The tax-invoice generation endpoint retains
its current storage behavior.

Cloudinary must allow PDF delivery in the account's Security settings. A blocked
delivery URL must be enabled before clients or ZIP downloads can retrieve PDFs.
Load tests include Cloudinary upload latency, bandwidth, storage, and account limits;
HTTP 201 means both the upload and MongoDB record creation completed.

Invoice generation limits concurrent operations per Node process using
`INVOICE_MAX_INFLIGHT` (default 64). When capacity is full, new generation requests
receive HTTP 503 with `code: INVOICE_BUSY` and `Retry-After: 1`, before any PDF or
upload work begins. Slots remain occupied until work settles even if the client
disconnects. This bounds the backlog; it does not guarantee a particular RPS.

HTTP completion logs include `invoice_user_lookup`, `invoice_pdf`,
`invoice_cloudinary_upload`, and `invoice_mongo_insert` durations in milliseconds.
Use these timings to identify the slow stage before increasing concurrency or
scaling Node processes. Full invoice payloads and PDF buffers are not logged.

Successful invoice responses also include these durations in the `Server-Timing`
header. The local invoice load-test helper reports average, p95, and max duration
for each stage across successful requests.

### Invoice PDF worker pool

IRN invoice PDFs are rendered in reusable Node worker threads. The API process
continues handling HTTP, MongoDB, and Cloudinary uploads while PDF workers run.
The API loads all PDF workers before accepting requests to avoid worker module
startup during the initial burst. Each worker keeps its own in-memory logo cache. No invoice PDFs are written to disk.
Tax invoice generation retains its existing behavior.

- `INVOICE_PDF_WORKERS`: defaults to available CPU parallelism minus one, capped
  at four and never below one; set explicitly for your deployment's CPU budget.
- `INVOICE_PDF_MAX_QUEUE`: maximum waiting PDF jobs, default 64. The separate
  `INVOICE_MAX_INFLIGHT` limit covers the entire invoice operation.
- `INVOICE_PDF_TIMEOUT_MS`: execution deadline per dispatched PDF job, default
  30000 ms; queue waiting time is additional. Timed-out workers are terminated.

The queue rejects excess jobs with HTTP 503, failed workers return HTTP 500, and
PDF execution deadlines return HTTP 504. Admitted jobs are not retried automatically.
Failed workers are replaced for subsequent work. Shutdown drains admitted invoices
and closes worker threads, subject to the server's existing shutdown deadline.
The `invoice_pdf` stage includes queue wait, worker startup when needed, and rendering.
Worker count is a CPU/memory tradeoff; increasing it does not increase Cloudinary
or MongoDB capacity. Validate sustained throughput under your actual payload.

For burstier arrival patterns, tune `INVOICE_MAX_INFLIGHT` after enabling workers.
For example, 50 requests/second with two-second request latency requires roughly
100 concurrent slots. Use a bounded limit and monitor memory, PDF queue time,
and Cloudinary latency; account for all processes when sizing shared services.
