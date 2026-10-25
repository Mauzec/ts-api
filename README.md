# Crypto Tracker

Личный список криптовалют на основе CoinMarketCap API.

## Быстрый старт

Перед запуском создайте .env, опираясь на .env.example. Не забудьте указать CoinMarketCap API key.

```sh
npm ci
npm run build
npm start
```

Откройте Swagger UI (`http://[host:port]/docs`) для проверки.

## API документанция

| `/api/v1`                           | Назначение                                                      |
| ----------------------------------- | --------------------------------------------------------------- |
| `POST /users`                       | Регистрация                                                     |
| `POST /api-keys`                    | Выпуск API-ключа. Сам API-ключ показывается только при создании |
| `GET /api-keys`                     | Метаданные API-ключей                                           |
| `DELETE /api-keys/:id`              | Отзыв API-ключа                                                 |
| `POST /cryptocurrencies`            | Подписаться на криптовалюту                                     |
| `GET /cryptocurrencies`             | Список криптовалют                                              |
| `GET /cryptocurrencies/:id`         | Карточка криптовалюты                                           |
| `PATCH /cryptocurrencies/:id`       | Редактирование криптовалюты                                     |
| `DELETE /cryptocurrencies/:id`      | Удаление криптовалюты                                           |
| `GET /cryptocurrencies/:id/price`   | Последняя цена криптовалюты                                     |
| `GET /cryptocurrencies/:id/history` | История изменения криптовалюты                                  |
| `GET /cryptocurrencies/:id/ohlc`    | Расчет свечей                                                   |
