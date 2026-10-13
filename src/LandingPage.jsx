import React from 'react';
import {appPath} from './app-base.js';
import portrait from './assets/hero-nikita-logo.png';
import board from './assets/board-preview.png';
import styles from './LandingPage.module.css';

const features = [
  ['01', 'Вся воронка перед глазами', 'Ведите сделки по этапам, сохраняйте историю и сразу видьте следующий шаг.'],
  ['02', 'Никто не потеряется', 'Контакты, компании и задачи связаны со сделками — информация остаётся у команды.'],
  ['03', 'Свобода подключений', 'Открытый API и webhooks помогают связать CRM с формами сайта и вашими сервисами.'],
];

export default function LandingPage() {
  const dealsPath = appPath('/deals');
  return <main id="opencrm-landing" className={styles.page}>
    <section className={styles.hero} aria-labelledby="opencrm-title">
      <div className={styles.glow} aria-hidden="true" />
      <header className={styles.nav}>
        <a className={styles.logo} href={appPath('/')} aria-label="OpenCRM — главная">Open<span>CRM.</span></a>
        <nav aria-label="Навигация OpenCRM" className={styles.navLinks}>
          <a href="#product">Продукт</a>
          <a href="#features">Возможности</a>
          <a href="#agency">Для B2B</a>
          <a href="https://github.com/nickerhov89/opencrm" target="_blank" rel="noopener noreferrer">GitHub ↗</a>
        </nav>
        <a className={styles.navDemo} href={dealsPath}>ОТКРЫТЬ CRM <span aria-hidden="true">↗</span></a>
      </header>
      <div className={styles.heroBody}>
        <div className={styles.heroCopy}>
          <p className={styles.kicker}>ХОТИТЕ УВЕЛИЧИТЬ<br />ПРОДАЖИ?</p>
          <h1 id="opencrm-title">НЕ ТЕРЯЙТЕ<br />КЛИЕНТОВ</h1>
          <p className={styles.heroIntro}>Сделки, контакты и задачи — в одной открытой CRM. Команда видит, кому ответить, что обещали и где сейчас каждая продажа.</p>
          <div className={styles.heroActions}>
            <a className={styles.primary} href={dealsPath}>ПОПРОБОВАТЬ БЕСПЛАТНО <span aria-hidden="true">↗</span></a>
            <a className={styles.more} href="#product">УЗНАТЬ БОЛЬШЕ <span aria-hidden="true">›</span></a>
          </div>
          <p className={styles.demoNote}>{import.meta.env.VITE_PUBLIC_DEMO === '1' ? 'Открытый код · Демо без регистрации · Вымышленные данные' : 'Открытый код · CRM для вашей команды'}</p>
        </div>
        <div className={styles.frame} aria-hidden="true" />
        <img className={styles.person} src={portrait} alt="Никита Соричев в футболке OpenCRM приглашает попробовать продукт" width="1448" height="1086" fetchPriority="high" />
      </div>
      <div className={styles.heroBottom}><span>OpenCRM © 2026 · Проект <a href="https://polzaagency.ru/">Polza Agency</a></span><a href="https://www.instagram.com/sorichev/" target="_blank" rel="noopener noreferrer">Instagram Никиты ↗</a></div>
    </section>
    <section className={styles.product} id="product" aria-labelledby="product-title">
      <div className={styles.sectionHeading}><span>ОТ ХАОСА К ЯСНОСТИ</span><h2 id="product-title">Все продажи<br />на одном экране.</h2><p>OpenCRM помогает не держать работу с клиентами в голове, чатах и таблицах. Начните с готового демо и посмотрите, как устроена воронка.</p></div>
      <div className={styles.preview}><div className={styles.previewTop}><span>OpenCRM</span><span>Воронка сделок</span><span>Демо</span></div><img src={board} alt="Воронка сделок OpenCRM с вымышленными данными" width="1440" height="900" loading="lazy" /></div>
    </section>
    <section className={styles.features} id="features" aria-label="Возможности OpenCRM">
      {features.map(([number, title, description]) => <article key={number}><span>{number}</span><h3>{title}</h3><p>{description}</p></article>)}
    </section>
    <section className={styles.agency} id="agency">
      <div><span>POLZA AGENCY</span><h2>Нужны клиенты B2B?</h2><p>CRM помогает вести продажи. Мы поможем наполнить воронку: найдём целевые компании, запустим аутрич и доведём интерес до встречи.</p></div>
      <a href="https://polzaagency.ru/#contact">Обсудить привлечение клиентов <span aria-hidden="true">↗</span></a>
    </section>
  </main>;
}
