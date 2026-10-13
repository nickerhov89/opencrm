export const dealCardFieldOptions=[
  ['client','Контакт и компания'],
  ['updated','Время обновления'],
  ['owner','Ответственный'],
  ['amount','Бюджет'],
  ['source','Источник'],
  ['tags','Теги'],
  ['task','Ближайшая задача'],
  ['last_communication','Последний контакт'],
];

export const defaultDealCardFields=['client','updated','owner','amount','source','tags','task'];

export const validDealCardFields=(fields,customFieldIds=[])=>Array.isArray(fields)&&fields.length>0&&fields.length<=7&&new Set(fields).size===fields.length&&fields.every(key=>dealCardFieldOptions.some(([allowed])=>allowed===key)||/^field:[1-9]\d*$/.test(key)&&customFieldIds.includes(Number(key.slice(6))));
