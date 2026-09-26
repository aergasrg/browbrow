// DOM and formatting helpers.

/**
 * @template {HTMLElement} T
 * @param {string} Id
 * @returns {T}
 */
export function byId(Id) {
  const Element = document.getElementById(Id);
  if (!Element) throw new Error(`Missing #${Id}`);
  return /** @type {T} */ (Element);
}

/** @param {number} Seconds */
export function formatDuration(Seconds) {
  const Total = Math.max(0, Math.floor(Seconds));
  const Hours = Math.floor(Total / 3600);
  const Minutes = Math.floor((Total % 3600) / 60);
  const Rest = String(Total % 60).padStart(2, '0');
  return Hours ? `${Hours}:${String(Minutes).padStart(2, '0')}:${Rest}` : `${Minutes}:${Rest}`;
}

/** @param {number | null | undefined} Value @param {number} [Digits] */
export function formatNumber(Value, Digits = 0) {
  if (Value === null || Value === undefined || !Number.isFinite(Value)) return '--';
  return Value.toFixed(Digits);
}

/** @typedef {'good' | 'warn' | 'bad'} Level */

/** @param {number} Confidence 0..1 @returns {Level} */
export function levelFor(Confidence) {
  if (Confidence >= 0.6) return 'good';
  if (Confidence >= 0.25) return 'warn';
  return 'bad';
}

/** @param {Level} Level */
export function qualityWord(Level) {
  return Level === 'good' ? 'Good' : Level === 'warn' ? 'Fair' : 'Poor';
}

/** @param {HTMLElement} Element @param {string} ClassName */
export function restartAnimation(Element, ClassName) {
  Element.classList.remove(ClassName);
  void Element.offsetWidth; // Force a reflow so the animation plays again.
  Element.classList.add(ClassName);
}

/**
 * Updates text only when it changes (avoids layout work every frame).
 * @param {Element} Element
 * @param {string} Text
 */
export function setText(Element, Text) {
  if (Element.textContent !== Text) Element.textContent = Text;
}

/**
 * @param {HTMLElement} Element
 * @param {string} Name
 * @param {string | undefined} Value
 */
export function setData(Element, Name, Value) {
  if (Value === undefined) {
    if (Name in Element.dataset) delete Element.dataset[Name];
  } else if (Element.dataset[Name] !== Value) {
    Element.dataset[Name] = Value;
  }
}
