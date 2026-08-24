// Proxies text-to-speech to Azure Speech (Levantine Arabic neural voices).
// The Azure key never reaches the browser — it only exists here, server-side.
//
// Hard quota gate: a monthly character counter lives in Netlify Blobs
// (persistent, shared across every invocation — NOT an in-memory counter,
// which would silently fail to enforce anything on serverless functions).
// Once the counter would cross the limit, this function refuses to call
// Azure at all. That's the real safety net; the Azure budget alert is a
// second, independent layer in case this one ever has a bug.

const { getStore } = require('@netlify/blobs');

// Deliberately far below Azure's ~500,000 free characters/month (F0 tier) —
// not just "under the free tier" but small enough that the counter's own
// worst-case race-condition overshoot (a burst of near-simultaneous requests
// can each read the counter before any of them writes it back, see
// AUTH_AND_SYNC.md) stays trivial in absolute terms, not just "still free."
// 100,000 chars/month is still ~15-20x a realistic month of real classroom
// usage (~5,000-6,000 word-plays) for this word list, so real users should
// never notice it.
const MONTHLY_CHAR_LIMIT = 100000;
const MAX_TEXT_LENGTH = 300; // a single card's text is a few words, never this long
const DEFAULT_VOICE = 'ar-LB-LaylaNeural'; // Lebanese — closest available to Palestinian dialect
const ALLOWED_VOICES = new Set([
  'ar-LB-LaylaNeural', 'ar-LB-RamiNeural',
  'ar-JO-TaimNeural',
  'ar-SY-AmanyNeural', 'ar-SY-LaithNeural',
]);

function escapeXml(s) {
  return s
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, body: 'Invalid JSON' };
  }

  const text = String(body.text || '').trim();
  const voice = ALLOWED_VOICES.has(body.voice) ? body.voice : DEFAULT_VOICE;

  // Optional IPA pronunciation. Arabic script cannot represent the spoken
  // Levantine vowels ē/ō (the reason the teachers invented their own marks),
  // so respelling the Arabic can only ever approximate them. IPA sidesteps
  // orthography entirely and states the sounds outright.
  // Whether Azure honours <phoneme> for Arabic voices is exactly what the
  // deploy of this change is meant to determine -- if it doesn't, the plain
  // text path below is unchanged and nothing regresses.
  const ipa = String(body.ipa || '').trim();
  if (ipa && ipa.length > MAX_TEXT_LENGTH) {
    return { statusCode: 400, body: 'IPA too long' };
  }

  // Optional speaking rate. Separate lever from `ipa`: the teacher's
  // "ignored the long vowel" complaint (كَسْلَان) is a DELIVERY fault, not a
  // spelling one -- the length is already written correctly and the engine
  // just doesn't hold it. Slowing delivery is the only control available for
  // that without recording a human. Whitelisted, since this value goes
  // straight into SSML.
  const ALLOWED_RATES = new Set(['x-slow', 'slow', 'medium', 'fast', 'x-fast']);
  const rate = ALLOWED_RATES.has(body.rate) ? body.rate : '';

  if (!text) return { statusCode: 400, body: 'Missing text' };
  if (text.length > MAX_TEXT_LENGTH) return { statusCode: 400, body: 'Text too long' };

  const region = process.env.AZURE_SPEECH_REGION;
  const key = process.env.AZURE_SPEECH_KEY;
  if (!region || !key) {
    return { statusCode: 500, body: 'Speech service not configured' };
  }

  // ── quota gate — runs BEFORE touching Azure ──────────────────────────
  // getStore() is supposed to auto-detect the site context on a real
  // deployed function, with no extra config. In practice that detection
  // sometimes fails on Netlify's side (MissingBlobsEnvironmentError, a
  // known platform issue, not specific to this app) — so site ID + a
  // token are passed explicitly as a fallback whenever they're set.
  const store = (process.env.NETLIFY_SITE_ID && process.env.NETLIFY_BLOBS_TOKEN)
    ? getStore({
        name: 'tts-usage',
        siteID: process.env.NETLIFY_SITE_ID,
        token: process.env.NETLIFY_BLOBS_TOKEN,
      })
    : getStore('tts-usage');
  const monthKey = new Date().toISOString().slice(0, 7); // e.g. "2026-08"
  const used = parseInt((await store.get(monthKey)) || '0', 10);

  if (used + text.length > MONTHLY_CHAR_LIMIT) {
    return {
      statusCode: 429,
      body: 'Monthly speech quota reached for this project — try again next month.',
    };
  }

  // ── call Azure ────────────────────────────────────────────────────
  // xml:lang must match the voice's own locale (e.g. "ar-LB" for
  // ar-LB-LaylaNeural) — a mismatched lang tag (this used to be hardcoded
  // to "ar-JO" regardless of voice) can make Azure apply the wrong
  // region's text-normalization/prosody rules on top of the right voice.
  const locale = voice.split('-').slice(0, 2).join('-');
  // With IPA present, wrap the text in <phoneme> so Azure speaks the stated
  // sounds instead of its own reading of the Arabic spelling. The text stays
  // inside the element as the written form, so if Azure ignores <phoneme> the
  // result is simply today's behaviour rather than silence.
  let spoken = ipa
    ? '<phoneme alphabet="ipa" ph="' + escapeXml(ipa) + '">' + escapeXml(text) + '</phoneme>'
    : escapeXml(text);
  if (rate) {
    spoken = '<prosody rate="' + rate + '">' + spoken + '</prosody>';
  }
  const ssml =
    '<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="' + locale + '">' +
    '<voice name="' + voice + '">' + spoken + '</voice>' +
    '</speak>';

  let azureRes;
  try {
    azureRes = await fetch(
      'https://' + region + '.tts.speech.microsoft.com/cognitiveservices/v1',
      {
        method: 'POST',
        headers: {
          'Ocp-Apim-Subscription-Key': key,
          'Content-Type': 'application/ssml+xml',
          'X-Microsoft-OutputFormat': 'audio-24khz-48kbitrate-mono-mp3',
        },
        body: ssml,
      }
    );
  } catch (e) {
    return { statusCode: 502, body: 'Could not reach speech service' };
  }

  if (!azureRes.ok) {
    const errText = await azureRes.text().catch(function () { return ''; });
    return { statusCode: 502, body: 'Speech service error: ' + azureRes.status + ' ' + errText };
  }

  // Only count characters — and only advance the counter — on success, so a
  // failed Azure call never eats into the quota for nothing.
  await store.set(monthKey, String(used + text.length));

  const audioBuffer = Buffer.from(await azureRes.arrayBuffer());
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store' },
    body: audioBuffer.toString('base64'),
    isBase64Encoded: true,
  };
};
