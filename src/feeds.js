/**
 * Direct publisher feeds per office.
 *
 * Aggregator wrappers (Google News) hide the publisher URL behind an encrypted
 * redirect that is frequently rate limited, so the desk cannot open the page.
 * These feeds return real article links that can be fetched and verified.
 */
export const PUBLISHER_FEEDS = {
  turin: [
    "https://www.ansa.it/piemonte/notizie/piemonte_rss.xml",
    "https://torino.repubblica.it/rss/rss2.0.xml",
    "https://www.torinotoday.it/rss",
  ],
  seoul: [
    "https://www.yna.co.kr/rss/news.xml",
    "https://www.koreaherald.com/rss/newsAll",
  ],
  madrid: [
    "https://www.europapress.es/rss/rss.aspx?ch=00300",
    "https://www.eldiario.es/rss/",
  ],
  malaga: [
    "https://www.laopiniondemalaga.es/rss/section/22000",
    "https://www.diariosur.es/rss/2.0/?section=malaga",
  ],
  amman: [
    "https://www.ammonnews.net/rss.aspx",
    "https://alghad.com/feed/",
  ],
  baghdad: [
    "https://www.ina.iq/rss.xml",
    "https://shafaq.com/ar/rss",
  ],
  osaka: [
    "https://www.asahi.com/rss/asahi/newsheadlines.rdf",
    "https://mainichi.jp/rss/etc/mainichi-flash.rss",
  ],
  athens: [
    "https://www.kathimerini.gr/feed/",
    "https://www.efsyn.gr/rss.xml",
  ],
  "northeast-england": [
    "https://www.chroniclelive.co.uk/news/?service=rss",
    "https://www.thenorthernecho.co.uk/news/rss/",
  ],
  muscat: [
    "https://www.omanobserver.om/feed/",
    "https://timesofoman.com/feed",
  ],
  pristina: ["https://www.koha.net/rss"],
  rabat: [
    "https://www.hespress.com/feed",
    "https://telquel.ma/feed",
  ],
};

export function publisherFeeds(mayorId) {
  return PUBLISHER_FEEDS[mayorId] || [];
}
