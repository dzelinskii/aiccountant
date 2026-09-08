<!-- Этот файл создан генератором, не правьте руками: правки затрёт следующая перегенерация, а CI её потребует. Источник — backend/scripts/gen_reference.py -->

# Ручки API

API **не версионирован**: все пути живут под `/api`, префикса версии нет.

- `GET /api/accounts` — List Accounts
- `POST /api/accounts` — Create Account
- `PATCH /api/accounts/{account_id}` — Update Account
- `POST /api/auth/login` — Login
- `POST /api/auth/logout` — Logout
- `POST /api/auth/register` — Register
- `GET /api/categories` — List Categories
- `POST /api/categories` — Create Category
- `PATCH /api/categories/{category_id}` — Update Category
- `GET /api/dashboard` — Dashboard
- `GET /api/description-rules` — List Description Rules
- `POST /api/description-rules` — Create Description Rule
- `DELETE /api/description-rules/{rule_id}` — Delete Description Rule
- `GET /api/health` — Health
- `GET /api/imports` — List Pending Imports
- `POST /api/imports` — Start Import
- `POST /api/imports/parsed` — Create Parsed Import
- `GET /api/imports/{import_id}` — Import Status
- `POST /api/imports/{import_id}/commit` — Commit Import
- `GET /api/me` — Me
- `GET /api/recurring` — List Rules
- `POST /api/recurring` — Create Rule
- `GET /api/recurring/occurrences` — List Occurrences
- `POST /api/recurring/occurrences/{occurrence_id}/confirm` — Confirm Occurrence
- `POST /api/recurring/occurrences/{occurrence_id}/skip` — Skip Occurrence
- `DELETE /api/recurring/{rule_id}` — Delete Rule
- `PATCH /api/recurring/{rule_id}` — Update Rule
- `GET /api/tokens` — List Tokens
- `POST /api/tokens` — Create Token
- `DELETE /api/tokens/{token_id}` — Revoke Token
- `GET /api/transactions` — List Transactions
- `POST /api/transactions` — Create Transaction
- `POST /api/transactions/categorize` — Categorize Transactions
- `POST /api/transactions/transfer` — Create Transfer
- `DELETE /api/transactions/{transaction_id}` — Delete Transaction
- `PATCH /api/transactions/{transaction_id}` — Update Transaction
- `POST /api/transactions/{transaction_id}/apply-category-to-similar` — Apply Category To Similar
- `POST /api/transactions/{transaction_id}/dismiss-suggestion` — Dismiss Suggestion
- `GET /api/transactions/{transaction_id}/similar-uncategorized` — Similar Uncategorized
- `POST /api/workspaces/{workspace_id}/members` — Add Member
