<!-- Этот файл создан генератором, не правьте руками: правки затрёт следующая перегенерация, а CI её потребует. Источник — backend/scripts/gen_reference.py -->

# Границы модулей

Проверяются import-linter при каждом прогоне CI; нарушение красит сборку.

### ledger service/repository не зависят от identity

- `app.ledger.service`, `app.ledger.repository` не импортируют `app.identity`
- исключение, разрешённое явно: `app.ledger.tasks -> app.core.celery_app`

### identity не зависит от ledger

- `app.identity.service`, `app.identity.models`, `app.identity.deps` не импортируют `app.ledger`

### recurring не лезет во внутренности identity и ledger

- `app.recurring.service`, `app.recurring.repository`, `app.recurring.tasks` не импортируют `app.identity`, `app.ledger.repository`, `app.ledger.models`
- исключение, разрешённое явно: `app.recurring.service -> app.ledger.service`
- исключение, разрешённое явно: `app.recurring.tasks -> app.core.celery_app`

### identity и ledger не зависят от recurring

- `app.identity.service`, `app.identity.models`, `app.identity.deps`, `app.ledger.service`, `app.ledger.repository`, `app.ledger.models` не импортируют `app.recurring`
- исключение, разрешённое явно: `app.ledger.tasks -> app.core.celery_app`

### imports не лезет во внутренности identity и ledger

- `app.imports.service`, `app.imports.repository`, `app.imports.parser`, `app.imports.routing`, `app.imports.llm_parser`, `app.imports.tasks` не импортируют `app.identity`, `app.ledger.repository`, `app.ledger.models`
- исключение, разрешённое явно: `app.imports.service -> app.ledger.service`
- исключение, разрешённое явно: `app.imports.tasks -> app.core.celery_app`

### identity и ledger не зависят от imports

- `app.identity.service`, `app.identity.models`, `app.identity.deps`, `app.ledger.service`, `app.ledger.repository`, `app.ledger.models` не импортируют `app.imports`
- исключение, разрешённое явно: `app.ledger.tasks -> app.core.celery_app`

### ai не зависит от доменных модулей

- `app.ai` не импортируют `app.identity`, `app.ledger`, `app.imports`, `app.recurring`
