<!-- Этот файл создан генератором, не правьте руками: правки затрёт следующая перегенерация, а CI её потребует. Источник — backend/scripts/gen_reference.py -->

# Ручки API

API **не версионирован**: все пути живут под `/api`, префикса версии нет. Кроме них приложение отдаёт служебные `/docs`, `/redoc` и `/openapi.json` — в схему OpenAPI они не входят (`include_in_schema=False`), поэтому в этот список не попадают.

- `GET /api/accounts` — отвечает списком `AccountOut`
- `POST /api/accounts` — принимает `AccountCreate`, отвечает `AccountOut`
- `PATCH /api/accounts/{account_id}` — принимает `AccountUpdate`, отвечает `AccountOut`
- `POST /api/auth/login` — принимает `LoginIn`, отвечает `UserOut`
- `POST /api/auth/logout`
- `POST /api/auth/register` — принимает `RegisterIn`, отвечает `UserOut`
- `GET /api/categories` — отвечает списком `CategoryOut`
- `POST /api/categories` — принимает `CategoryCreate`, отвечает `CategoryOut`
- `PATCH /api/categories/{category_id}` — принимает `CategoryUpdate`, отвечает `CategoryOut`
- `GET /api/counterparties` — отвечает списком `CounterpartyOut`
- `POST /api/counterparties` — принимает `CounterpartyCreate`, отвечает `CounterpartyOut`
- `GET /api/counterparties/unknown-signatures` — отвечает списком `UnknownSignatureOut`
- `DELETE /api/counterparties/{counterparty_id}`
- `PATCH /api/counterparties/{counterparty_id}` — принимает `CounterpartyUpdate`, отвечает `CounterpartyOut`
- `GET /api/dashboard` — отвечает `DashboardOut`
- `GET /api/description-rules` — отвечает списком `DescriptionRuleOut`
- `POST /api/description-rules` — принимает `DescriptionRuleCreate`, отвечает `DescriptionRuleOut`
- `DELETE /api/description-rules/{rule_id}`
- `GET /api/health`
- `GET /api/imports` — отвечает списком `ImportListItemOut`
- `POST /api/imports` — отвечает `ImportStartedOut`
- `POST /api/imports/parsed` — принимает `ParsedImportIn`, отвечает `ImportStartedOut`
- `GET /api/imports/{import_id}` — отвечает `ImportStatusOut`
- `POST /api/imports/{import_id}/commit` — отвечает `ImportResultOut`
- `GET /api/me` — отвечает `MeOut`
- `GET /api/recurring` — отвечает списком `RuleOut`
- `POST /api/recurring` — принимает `RuleCreate`, отвечает `RuleOut`
- `GET /api/recurring/occurrences` — отвечает списком `OccurrenceOut`
- `POST /api/recurring/occurrences/{occurrence_id}/confirm` — принимает `OccurrenceConfirm`, отвечает `OccurrenceOut`
- `POST /api/recurring/occurrences/{occurrence_id}/skip` — отвечает `OccurrenceOut`
- `DELETE /api/recurring/{rule_id}`
- `PATCH /api/recurring/{rule_id}` — принимает `RuleUpdate`, отвечает `RuleOut`
- `GET /api/tokens` — отвечает списком `ApiTokenOut`
- `POST /api/tokens` — принимает `ApiTokenCreate`, отвечает `ApiTokenCreated`
- `DELETE /api/tokens/{token_id}`
- `GET /api/transactions` — отвечает `TransactionList`
- `POST /api/transactions` — принимает `TransactionCreate`, отвечает `TransactionOut`
- `POST /api/transactions/categorize`
- `POST /api/transactions/transfer` — принимает `TransferCreate`, отвечает `TransactionList`
- `DELETE /api/transactions/{transaction_id}`
- `PATCH /api/transactions/{transaction_id}` — принимает `TransactionUpdate`, отвечает `TransactionOut`
- `POST /api/transactions/{transaction_id}/apply-category-to-similar` — отвечает `SimilarAppliedOut`
- `POST /api/transactions/{transaction_id}/dismiss-suggestion` — отвечает `TransactionOut`
- `GET /api/transactions/{transaction_id}/similar-uncategorized` — отвечает `SimilarUncategorizedOut`
- `POST /api/workspaces/{workspace_id}/members` — принимает `MemberIn`
