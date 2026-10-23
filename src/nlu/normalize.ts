/**
 * Совместимость: парсер вынесен в самостоятельный пакет `ru-datetime-parser`.
 * Приложение продолжает импортировать `src/nlu/*`, чтобы не менять все вызовы.
 */

export * from '../../ru-datetime-parser/src/normalize';
