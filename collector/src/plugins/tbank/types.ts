// Модель переехала в общий контракт: она одна на все банки. Файл оставлен
// реэкспортом, чтобы не переписывать импорты внутри плагина.
export type { CollectedAccount, CollectedOperation } from '../../core/contract'
