# Плагины OpenCRM

Плагин добавляет в OpenCRM то, чего нет в ядре: приём заявок из внешних сервисов, телефонию, мессенджеры, свои отчёты. Он не меняет код CRM: это отдельный пакет, который администратор загружает в **Настройки → Плагины** и включает переключателем.

Примеры лежат в [`examples/plugins`](../examples/plugins):

- [`tilda-forms`](../examples/plugins/tilda-forms) — заявки из форм Tilda попадают в «Неразобранное». Это настоящий плагин, его можно ставить в работу.
- [`hello-world`](../examples/plugins/hello-world) — показывает все точки расширения: страницу в левом меню, блок в карточке сделки, свой API, события и хранилище.

> **Плагин — это доверенный код.** Серверная часть работает внутри процесса CRM и видит всю базу. Ставьте только плагины, которым доверяете. Устанавливать, настраивать и удалять плагины может только администратор, все действия попадают в журнал безопасности. Загрузку через интерфейс можно выключить переменной `OPENCRM_PLUGIN_UPLOAD=0`; тогда плагины ставятся только командой на сервере.

## Пакет

Плагин — это папка, а для загрузки — её ZIP-архив:

```
tilda-forms/
  plugin.json        описание (обязательно)
  server.js          серверная часть (по желанию)
  client/index.js    часть для браузера (по желанию)
```

В архиве `plugin.json` может лежать в корне или внутри одной папки верхнего уровня. Ограничения: до 500 файлов, до 50 МБ в распакованном виде, без ссылок (symlink) и путей с `..`.

### plugin.json

```json
{
  "id": "tilda-forms",
  "name": "Формы Tilda",
  "version": "1.0.0",
  "api": 1,
  "description": "Заявки из форм на сайте Tilda попадают в «Неразобранное».",
  "author": "OpenCRM",
  "server": "server.js",
  "client": "client/index.js",
  "settings": [
    {"key": "token", "label": "Ключ для Tilda", "type": "password", "required": true, "help": "Подсказка под полем"},
    {"key": "pipeline_id", "label": "ID воронки", "type": "number"},
    {"key": "greeting", "label": "Приветствие", "type": "text", "default": "Привет", "public": true}
  ],
  "endpoints": [
    {"path": "/hook", "label": "Адрес webhook для Tilda"}
  ]
}
```

| Поле | |
|---|---|
| `id` | 2–50 символов: латиница в нижнем регистре, цифры, дефис. Неизменен между версиями. |
| `name`, `description`, `author` | Видны в настройках. |
| `version` | `major.minor.patch`. Загрузка пакета с тем же `id` обновляет плагин и сохраняет его настройки и данные. |
| `api` | Версия API плагинов. Сейчас `1`. |
| `server` | ES-модуль для сервера (`.js`/`.mjs`). |
| `client` | ES-модуль для браузера. Если он лежит в папке (`client/index.js`), браузер может загрузить любые файлы этой папки; если в корне — только сам файл. |
| `settings` | Поля настроек. Форму OpenCRM строит сам. Типы: `text`, `textarea`, `password`, `number`, `boolean`, `select` (с `options`: строки или `{value, label}`). `required` — без значения плагин не включится. `public: true` — значение передаётся в браузерную часть. `password` хранятся зашифрованными, не возвращаются в интерфейс и никогда не уходят в браузер. |
| `endpoints` | Публичные адреса плагина, которые администратор копирует во внешний сервис. Только для показа в настройках, маршруты объявляет сам плагин. |

## Серверная часть

Модуль экспортирует `activate(ctx)` (или `export default`). OpenCRM вызывает её при включении, после смены настроек, обновления и при старте сервера. `activate` может вернуть функцию остановки; также можно экспортировать `deactivate(ctx)`.

```js
export async function activate(ctx) {
  ctx.router.get('/stats', async (req, res) => res.json({user: req.user.name}));
  ctx.publicRouter.post('/hook', async (req, res) => {
    await ctx.crm.createLead({title: 'Заявка', phone: req.body.phone});
    res.send('ok');
  });
  ctx.on('deal.stage_changed', async event => ctx.log.info(`Сделка ${event.data.id}`));
  const stop = ctx.every(60_000, async () => { /* синхронизация */ });
  return () => stop();
}
```

| `ctx` | |
|---|---|
| `id`, `version`, `manifest`, `dir` | Данные плагина и папка с его файлами. |
| `settings` | Текущие настройки (объект). При их смене плагин перезапускается. |
| `router` | Express-роутер на `/api/plugins/<id>/…`. Нужен вход в CRM; пользователь — в `req.user` (`id`, `name`, `email`, `role`). Права проверяйте сами. |
| `publicRouter` | Роутер на `/api/plugins/<id>/public/…` **без входа** — для входящих вебхуков. Тело в JSON, `x-www-form-urlencoded` или текстом, до 1 МБ. Проверяйте секрет (см. пример Tilda). Запросы из браузера с другого сайта отклоняются защитой CRM; серверные запросы проходят. |
| `publicPath(path)` | Путь публичного адреса, например `/api/plugins/tilda-forms/public/hook`. |
| `on(event, handler)` | Подписка на события CRM. Те же события, что у webhooks ([список](INTEGRATIONS.md)): `lead.created`, `deal.created`, `deal.updated`, `deal.stage_changed`, `deal.deleted`, `contact.*`, `company.*`, `task.*`, `note.created`. Обработчик получает `{id, type, created_at, data}`. События приходят из очереди через 1–3 секунды; плагин получает события с момента включения. Доставка — не больше одного раза: если обработчик упал, ошибка пишется в журнал плагина, повтора нет. |
| `every(ms, task)` | Периодическая задача (не чаще раза в секунду, без наложения запусков). Возвращает функцию остановки; при выключении плагина останавливается сама. |
| `storage` | Хранилище плагина в базе: `get(key)`, `set(key, value)` (JSON до 1 МБ), `delete(key)`, `list(prefix)`. Удаляется вместе с плагином. |
| `crm.createLead({...})` | Заявка в «Неразобранное»: `title`, `contact_name`, `company_name`, `phone`, `email`, `website`, `source`, `message`, `pipeline_id` (по умолчанию первая воронка). |
| `crm.addDealEvent(dealId, text)` | Событие в ленте сделки с подписью плагина. |
| `crm.addEntityEvent('contact' \| 'company', id, text)` | Событие в истории контакта или компании. |
| `crm.addNote(dealId, text)` | Примечание в сделке. |
| `db` | База CRM: `await db.prepare(sql).get/all/run(...params)`, плейсхолдеры `?`. Схема — [server/db.js](../server/db.js). Пишите аккуратно: ограничений, кроме схемы, нет. |
| `log.info/warn/error` | Журнал плагина: последние 200 записей видны в настройках. |
| `audit(action, details)` | Запись в журнал безопасности как `plugin.<id>.<action>`. |

Ошибка в `activate` не роняет CRM: плагин помечается «Ошибка запуска», текст виден в настройках. Модуль импортируется заново при каждом запуске, но только сам файл `server`: если серверная часть состоит из нескольких файлов, соберите её в один (например, esbuild) или перезапускайте CRM после обновления.

## Часть для браузера

Обычный ES-модуль. Он загружается после входа и не может импортировать пакеты: React даёт CRM.

```js
export default function activate(api) {
  const {h, useState, useEffect} = api;
  function Page() {
    const [data, setData] = useState(null);
    useEffect(() => { api.fetch('/stats').then(setData); }, []);
    return h('div', {className: 'plugin-card'}, data ? `Привет, ${data.user}` : 'Загрузка…');
  }
  api.addPage({id: 'stats', label: 'Отчёт', icon: 'chart', render: Page});
  api.addDealPanel({id: 'info', title: 'Мой блок', render: ({deal}) => h('p', null, deal.name)});
}
```

| `api` | |
|---|---|
| `id`, `name`, `version`, `user` | Плагин и текущий пользователь. |
| `settings` | Настройки с `public: true`. |
| `React`, `h`, `useState`, `useEffect`, `useMemo`, `useRef` | React приложения (`h` = `React.createElement`). |
| `fetch(path, {method, body})` | Запрос к своему серверу: `/api/plugins/<id><path>`. JSON в обе стороны, при ошибке — исключение с текстом от сервера. |
| `api(path, options)` | Запрос к API CRM от имени пользователя (`/api<path>`), например `api.api('/deals/42')`. |
| `notify(text)` | Всплывающее сообщение. |
| `openDeal(id)` | Открыть карточку сделки. |
| `addPage({id, label, title, icon, render \| mount})` | Пункт в левом меню и страница по адресу `/apps/<plugin>/<id>`. Иконки: `puzzle`, `sparkles`, `phone`, `message`, `mail`, `form`, `chart`, `plug`, `star`, `bell`, `globe`. |
| `addDealPanel({id, title, render \| mount})` | Блок в левой колонке карточки сделки. Получает `{deal}`. |

`render` — React-компонент. Если удобнее без React, передайте `mount(element, props)`: рисуйте в `element` и верните функцию очистки или объект `{update(props), unmount()}`. Ошибка внутри блока плагина не ломает страницу: на месте блока появится сообщение. Готовые классы оформления: `plugin-card` (белая карточка), `plugin-muted`.

Администратор видит разделы плагина сразу после включения; остальным сотрудникам и после правки браузерной части нужно обновить страницу.

## Установка и разработка

В интерфейсе: **Настройки → Плагины → Загрузить плагин**, выберите ZIP, заполните настройки, включите.

На сервере (каталог плагинов — `PLUGINS_DIR`, по умолчанию `data/plugins` рядом с `data/uploads`; в Docker это том `opencrm_data`):

```bash
npm run plugin -- pack examples/plugins/tilda-forms   # проверить plugin.json и собрать tilda-forms-1.0.0.zip
npm run plugin -- install tilda-forms-1.0.0.zip      # или путь к папке
npm run plugin -- list
npm run plugin -- enable tilda-forms                 # disable — выключить
```

`install`, `enable` и `disable` из командной строки начинают действовать после перезапуска CRM. В Docker: `docker compose exec opencrm node scripts/plugin.mjs list`. Папка, скопированная в каталог плагинов вручную, появляется в настройках выключенной; имя папки должно совпадать с `id`.

Для разработки положите папку плагина в `data/plugins/<id>` и запустите `npm run dev`: после правки серверной части выключите и включите плагин (или сохраните настройки), после правки браузерной — обновите страницу.

Если CRM запущена в нескольких экземплярах, у каждого должен быть доступ к одному каталогу плагинов; включение и настройки применяются сразу на том экземпляре, где их поменяли, на остальных — после перезапуска. События при этом получает один экземпляр.

Плагины не входят в резервную копию (`npm run backup` сохраняет базу и вложения): храните ZIP-архивы своих плагинов отдельно. Их настройки и данные хранятся в базе и в копию попадают.

## Формы Tilda

1. Загрузите `tilda-forms` (соберите архив: `npm run plugin -- pack examples/plugins/tilda-forms`).
2. В настройках плагина задайте «Ключ для Tilda» — длинную случайную строку, при желании ID воронки и источник. Включите плагин.
3. В Tilda: **Настройки сайта → Формы → Webhook**. Адрес — «Адрес webhook для Tilda» из настроек плагина (CRM должна быть доступна из интернета по HTTPS). API-ключ: имя `api_key`, значение — ваш ключ, способ передачи — POST-параметр или Header.
4. Подключите webhook к нужным формам. Каждая отправка формы создаёт заявку в «Неразобранном»: имя, телефон и e-mail разбираются из полей `Name`/`Phone`/`Email`, остальные поля и UTM-метки попадают в текст заявки. Повторная доставка с тем же `tranid` новую заявку не создаёт.
