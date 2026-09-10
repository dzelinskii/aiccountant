<!-- Этот файл создан генератором, не правьте руками: правки затрёт следующая перегенерация, а CI её потребует. Источник — backend/scripts/gen_reference.py -->

# Схема базы данных

## `users`

- `id` · `UUID` · обязательна · первичный ключ
- `email` · `VARCHAR(320)` · обязательна
- `password_hash` · `VARCHAR(255)` · обязательна
- `created_at` · `TIMESTAMP WITH TIME ZONE` · обязательна · по умолчанию `now()`

## `workspaces`

- `id` · `UUID` · обязательна · первичный ключ
- `name` · `VARCHAR(200)` · обязательна
- `type` · `VARCHAR(20)` · обязательна
- `created_at` · `TIMESTAMP WITH TIME ZONE` · обязательна · по умолчанию `now()`

## `accounts`

- `id` · `UUID` · обязательна · первичный ключ
- `workspace_id` · `UUID` · обязательна · → `workspaces.id`
- `name` · `VARCHAR(200)` · обязательна
- `type` · `VARCHAR(20)` · обязательна
- `currency` · `VARCHAR(3)` · обязательна
- `is_archived` · `BOOLEAN` · обязательна
- `reported_balance` · `NUMERIC(20, 4)` · может быть пустой
- `reported_at` · `TIMESTAMP WITH TIME ZONE` · может быть пустой
- `balance_adjustment` · `NUMERIC(20, 4)` · обязательна · по умолчанию `0`
- `card_masks` · `JSONB` · обязательна · по умолчанию `'[]'`
- `created_at` · `TIMESTAMP WITH TIME ZONE` · обязательна · по умолчанию `now()`

## `api_tokens`

- `id` · `UUID` · обязательна · первичный ключ
- `workspace_id` · `UUID` · обязательна · → `workspaces.id`
- `created_by` · `UUID` · обязательна · → `users.id`
- `name` · `VARCHAR(100)` · обязательна
- `token_hash` · `VARCHAR(64)` · обязательна
- `created_at` · `TIMESTAMP WITH TIME ZONE` · обязательна · по умолчанию `now()`
- `last_used_at` · `TIMESTAMP WITH TIME ZONE` · может быть пустой
- `revoked_at` · `TIMESTAMP WITH TIME ZONE` · может быть пустой

## `categories`

- `id` · `UUID` · обязательна · первичный ключ
- `workspace_id` · `UUID` · обязательна · → `workspaces.id`
- `parent_id` · `UUID` · может быть пустой · → `categories.id`
- `name` · `VARCHAR(200)` · обязательна
- `kind` · `VARCHAR(20)` · обязательна
- `hint` · `VARCHAR(30)` · может быть пустой
- `created_at` · `TIMESTAMP WITH TIME ZONE` · обязательна · по умолчанию `now()`

Индексы:
- `ix_categories_workspace_hint` (уникальный): `workspace_id`, `hint`

## `memberships`

- `user_id` · `UUID` · обязательна · первичный ключ · → `users.id`
- `workspace_id` · `UUID` · обязательна · первичный ключ · → `workspaces.id`
- `role` · `VARCHAR(20)` · обязательна
- `created_at` · `TIMESTAMP WITH TIME ZONE` · обязательна · по умолчанию `now()`

## `counterparties`

- `id` · `UUID` · обязательна · первичный ключ
- `workspace_id` · `UUID` · обязательна · → `workspaces.id`
- `name` · `VARCHAR(200)` · обязательна
- `kind` · `VARCHAR(20)` · обязательна
- `category_id` · `UUID` · может быть пустой · → `categories.id`
- `created_at` · `TIMESTAMP WITH TIME ZONE` · обязательна · по умолчанию `now()`

## `imports`

- `id` · `UUID` · обязательна · первичный ключ
- `workspace_id` · `UUID` · обязательна · → `workspaces.id`
- `account_id` · `UUID` · обязательна · → `accounts.id`
- `file_name` · `VARCHAR(300)` · обязательна
- `bank_profile` · `VARCHAR(30)` · обязательна
- `status` · `VARCHAR(20)` · обязательна
- `stats` · `JSONB` · обязательна
- `parser` · `VARCHAR(30)` · может быть пустой
- `parsed_payload` · `JSONB` · может быть пустой
- `error` · `VARCHAR(500)` · может быть пустой
- `raw_text` · `TEXT` · может быть пустой
- `created_by` · `UUID` · обязательна · → `users.id`
- `created_at` · `TIMESTAMP WITH TIME ZONE` · обязательна · по умолчанию `now()`

## `recurring_rules`

- `id` · `UUID` · обязательна · первичный ключ
- `workspace_id` · `UUID` · обязательна · → `workspaces.id`
- `account_id` · `UUID` · обязательна · → `accounts.id`
- `category_id` · `UUID` · может быть пустой · → `categories.id`
- `amount` · `NUMERIC(20, 4)` · обязательна
- `currency` · `VARCHAR(3)` · обязательна
- `period` · `VARCHAR(10)` · обязательна
- `interval` · `INTEGER` · обязательна
- `anchor_day` · `INTEGER` · может быть пустой
- `start_date` · `DATE` · обязательна
- `next_run_at` · `DATE` · обязательна
- `mode` · `VARCHAR(10)` · обязательна
- `is_active` · `BOOLEAN` · обязательна
- `end_date` · `DATE` · может быть пустой
- `note` · `VARCHAR(1000)` · может быть пустой
- `created_by` · `UUID` · обязательна · → `users.id`
- `created_at` · `TIMESTAMP WITH TIME ZONE` · обязательна · по умолчанию `now()`

Индексы:
- `ix_recurring_rules_active_next` (обычный): `is_active`, `next_run_at`

## `transactions`

- `id` · `UUID` · обязательна · первичный ключ
- `workspace_id` · `UUID` · обязательна · → `workspaces.id`
- `account_id` · `UUID` · обязательна · → `accounts.id`
- `category_id` · `UUID` · может быть пустой · → `categories.id`
- `amount` · `NUMERIC(20, 4)` · обязательна
- `currency` · `VARCHAR(3)` · обязательна
- `occurred_at` · `DATE` · обязательна
- `merchant` · `VARCHAR(300)` · может быть пустой
- `note` · `VARCHAR(1000)` · может быть пустой
- `source` · `VARCHAR(20)` · обязательна
- `transfer_group_id` · `UUID` · может быть пустой
- `operation_kind` · `VARCHAR(20)` · обязательна · по умолчанию `'unknown'`
- `spending_override` · `BOOLEAN` · может быть пустой
- `external_id` · `VARCHAR(64)` · может быть пустой
- `import_id` · `UUID` · может быть пустой
- `category_confirmed` · `BOOLEAN` · обязательна · по умолчанию `false`
- `category_confidence` · `NUMERIC(4, 3)` · может быть пустой
- `suggested_category_id` · `UUID` · может быть пустой · → `categories.id`
- `created_by` · `UUID` · обязательна · → `users.id`
- `created_at` · `TIMESTAMP WITH TIME ZONE` · обязательна · по умолчанию `now()`

Индексы:
- `ix_transactions_account_occurred` (обычный): `account_id`, `occurred_at`
- `ix_transactions_workspace_occurred` (обычный): `workspace_id`, `occurred_at`
- `uq_transactions_account_external` (уникальный): `account_id`, `external_id`

## `description_rules`

- `id` · `UUID` · обязательна · первичный ключ
- `workspace_id` · `UUID` · обязательна · → `workspaces.id`
- `normalized_text` · `VARCHAR(300)` · обязательна
- `category_id` · `UUID` · может быть пустой · → `categories.id`
- `counterparty_id` · `UUID` · может быть пустой · → `counterparties.id`
- `source` · `VARCHAR(20)` · обязательна
- `created_at` · `TIMESTAMP WITH TIME ZONE` · обязательна · по умолчанию `now()`

## `recurring_occurrences`

- `id` · `UUID` · обязательна · первичный ключ
- `workspace_id` · `UUID` · обязательна · → `workspaces.id`
- `rule_id` · `UUID` · обязательна · → `recurring_rules.id`
- `due_date` · `DATE` · обязательна
- `amount` · `NUMERIC(20, 4)` · обязательна
- `status` · `VARCHAR(10)` · обязательна
- `transaction_id` · `UUID` · может быть пустой · → `transactions.id`
- `created_at` · `TIMESTAMP WITH TIME ZONE` · обязательна · по умолчанию `now()`

Индексы:
- `ix_recurring_occurrences_workspace_status` (обычный): `workspace_id`, `status`
