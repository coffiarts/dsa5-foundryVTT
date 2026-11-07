import MoneyTracker from '../orwell/money-tracker.js';
import DSA5SoundEffect from '../helpers/dsa-soundeffect.js';
import DSA5_Utility from '../helpers/utility-dsa5.js';
import DiceDSA5 from '../rolls/dice-dsa5.js';

export default class DSA5Payment {

  /** Currency sets per compendium id: { currencies (largest first, Mammon excluded), lead }. */
  static #currencySets = new Map();

  /** Resolve a money compendium id: explicit id, else the global setting, else the system language pack. */
  static currencyPackId(packId = '') {
    for (const id of [packId, game.settings.get('dsa5', 'moneyKompendium')]) {
      if (id && game.packs.get(id)) return id;
    }
    return DSA5_Utility.getLanguagePack();
  }

  /** Load (or reload) the currencies of one compendium into the cache. */
  static async loadCurrencies(packId = '') {
    const id = this.currencyPackId(packId);
    const items = await DSA5_Utility.getCompendiumEntries(id, 'money');
    const currencies = items
      .filter((x) => x.system.subcategory != 1)
      .sort((a, b) => b.system.price.value - a.system.price.value)
      .map((x) => ({
        name: _loc(x.name),
        value: Number(x.system.price.value),
        img: x.img,
        lead: !!x.flags?.dsa5?.leadCurrency,
      }));
    const names = currencies.map((c) => c.name);
    for (const c of currencies) c.abbr = this.#abbreviate(c.name, names);
    const set = { currencies, lead: this.#pickLeadCurrency(currencies) };
    this.#currencySets.set(id, set);
    return set;
  }

  /** Cached currency set of a compendium (synchronous); null if not loaded yet. */
  static currenciesFor(packId = '') {
    return this.#currencySets.get(this.currencyPackId(packId)) ?? null;
  }

  static async refreshCurrencyCache() {
    return (await this.loadCurrencies()).currencies;
  }

  /** Flagged lead coin wins; otherwise the coin whose value is closest to 1 S (ratio, not difference). */
  static #pickLeadCurrency(currencies) {
    const flagged = currencies.filter((c) => c.lead);
    if (flagged.length > 1) {
      console.warn(`DSA5 | Multiple lead currencies flagged (${flagged.map((c) => c.name).join(', ')}), using ${flagged[0].name}`);
    }
    if (flagged.length) return flagged[0];
    return currencies
      .filter((c) => c.value > 0)
      .reduce((best, c) => (!best || Math.abs(Math.log(c.value)) < Math.abs(Math.log(best.value)) ? c : best), null);
  }

  /** Find the shortest unique prefix (min. 1 letter) for each coin, e.g. conflicting names "Dukat"/"Denar" -> "Du"/"De". */
  static #abbreviate(name, allNames) {
    const others = allNames.filter((n) => n !== name).map((n) => n.toLowerCase());
    for (let k = 1; k <= name.length; k++) {
      const prefix = name.slice(0, k).toLowerCase();
      if (!others.some((o) => o.startsWith(prefix))) return name.slice(0, k);
    }
    return name;
  }

  /** Reload one compendium's currencies (default: the global one) and re-render open merchant sheets. */
  static async refreshCurrencyDisplay(packId = '') {
    await this.loadCurrencies(packId);
    for (const app of foundry.applications.instances.values()) {
      if (app.actor?.isMerchant?.()) app.render();
    }
  }

  /** Keep the currency cache in sync with coin edits in the global or any shop-used money compendium. Call once on ready. */
  static registerCurrencyHooks() {
    const onMoneyItemChange = (item) => {
      if (item.type !== 'money' || !item.pack) return;
      if (item.pack !== this.currencyPackId() && !this.#currencySets.has(item.pack)) return;
      this.refreshCurrencyDisplay(item.pack);
    };
    for (const hook of ['createItem', 'updateItem', 'deleteItem']) Hooks.on(hook, onMoneyItemChange);
    Hooks.on('updateItem', (item, changes, _options, userId) => this.#enforceSingleLeadCurrency(item, changes, userId));
  }

  /** Flagging a lead coin unflags all other coins in the same compendium (radio behaviour). */
  static async #enforceSingleLeadCurrency(item, changes, userId) {
    if (userId !== game.user.id || item.type !== 'money' || !item.pack) return;
    if (foundry.utils.getProperty(changes, 'flags.dsa5.leadCurrency') !== true) return;
    const others = (await game.packs.get(item.pack).getDocuments())
      .filter((x) => x.type === 'money' && x.id !== item.id && x.getFlag('dsa5', 'leadCurrency'));
    for (const other of others) await other.unsetFlag('dsa5', 'leadCurrency');
  }

  /**
   * Split a silverthaler amount into coins, largest first. A remainder the smallest coin cannot
   * represent is rounded up by one smallest coin. Shared by payment and price display.
   * @param {number} money
   * @param {{value: number}[]} currencies sorted by value, descending
   * @returns {object[]} each currency entry plus its `amount`
   */
  static splitAmount(money, currencies) {
    const res = [];
    let remaining = money;
    for (const currency of currencies) {
      const amount = Math.floor(remaining / currency.value);
      res.push({ ...currency, amount });
      remaining -= amount * currency.value;
    }
    if (remaining > 0.001 && res.length) res[res.length - 1].amount += 1;
    return res;
  }

  static async executePayment(actor, mode, moneyString, options = {}) {
    const { silent = false, render = true, showChatMessage = !silent, notifyOnFailure = silent, track = !silent, description = '', showDice = true } = options;

    if (!actor) {
      return {
        success: false,
        msg: _loc('PAYMENT.onlyActors'),
        money: 0,
      };
    }

    const evaluated = await this.evaluatePaymentAmount(moneyString, { showDice });
    if (!evaluated) {
      if (showChatMessage) this.parsePaymentAmount(moneyString, mode, true);
      return {
        success: false,
        msg: _loc('PAYMENT.error'),
        money: 0,
      };
    }

    if (mode === 'pay') {
      const canPay = await DSA5Payment.canPay(actor, evaluated.money, notifyOnFailure);
      if (canPay.success) await DSA5Payment._updateMoney(actor, canPay.actorsMoney.money, canPay.actorsMoney.sum - canPay.money, render, track, description);

      if (showChatMessage && canPay.msg != '') ChatMessage.create(DSA5_Utility.chatDataSetup(`<p>${canPay.msg}</p>`, 'roll'));

      return canPay;
    }

    const money = evaluated.money;

    const actorsMoney = this._actorsMoney(actor);
    await DSA5Payment._updateMoney(actor, actorsMoney.money, actorsMoney.sum + money, render, track, description);
    const msg = `<p>${_loc('PAYMENT.getPaid', { actor: actor.name, amount: await DSA5Payment._moneyToString(money) })}</p>`;
    if (showChatMessage) {
      ChatMessage.create(DSA5_Utility.chatDataSetup(msg, 'roll'));
    }
    return {
      success: true,
      msg: _loc('PAYMENT.getPaid', { actor: actor.name, amount: await DSA5Payment._moneyToString(money) }),
      money,
      actorsMoney,
    };
  }

  static async payMoney(actor, moneyString, silent = false, render = true, description = '') {
    const result = await DSA5Payment.executePayment(actor, 'pay', moneyString, {
      silent,
      render,
      showChatMessage: !silent,
      notifyOnFailure: silent,
      description,
    });

    return result.success;
  }

  static async canPay(actor, moneyString, silent) {
    const money = (await this.evaluatePaymentAmount(moneyString, { showDice: false }))?.money;
    const result = { success: false, msg: '', money: money || 0 };

    if (money) {
      result.actorsMoney = this._actorsMoney(actor);
      if (result.actorsMoney.sum >= money) {
        result.msg = _loc('PAYMENT.pay', {
          actor: actor.name,
          amount: await DSA5Payment._moneyToString(money),
        });
        result.success = true;
      } else {
        result.msg = _loc('PAYMENT.cannotpay', {
          actor: actor.name,
          amount: await DSA5Payment._moneyToString(money),
        });
        if (silent) {
          ui.notifications.info(result.msg);
        }
      }
    }
    return result;
  }

  static async getMoney(actor, moneyString, silent = false, render = true, description = '') {
    const result = await this.executePayment(actor, 'getPaid', moneyString, {
      silent,
      render,
      showChatMessage: !silent,
      notifyOnFailure: false,
      description,
    });
    return result.success;
  }

  static parsePaymentAmount(moneyString, mode = 'pay', announceError = true) {
    return mode === 'pay' ? this._getPaymoney(moneyString, announceError) : this._getPaidmoney(moneyString, announceError);
  }

  static paymentAmountFromDataset(element) {
    const raw = element?.dataset?.modifier ?? '';
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }

  static #isNumericRoll(roll) {
    return roll?.terms.length === 1 && roll.terms[0] instanceof foundry.dice.terms.NumericTerm;
  }

  /**
   * Parse a payment amount as a Foundry Roll (plain number or formula).
   * @returns {Roll|null}
   */
  static paymentRoll(amount) {
    if (amount instanceof Roll) return amount.clone();
    if (typeof amount === 'number') {
      return Number.isFinite(amount) ? new Roll(String(amount)) : null;
    }

    const formula = DiceDSA5.replaceDieLocalization(String(amount ?? '').trim().replaceAll(',', '.'));
    if (!formula || !Roll.validate(formula)) return null;

    try {
      return new Roll(formula);
    } catch {
      return null;
    }
  }

  static isValidPaymentFormula(amount) {
    const roll = this.paymentRoll(amount);
    if (!roll) return false;
    return !this.#isNumericRoll(roll) || roll.terms[0].number > 0;
  }

  /**
   * Resolve a silverthaler amount from a number or Foundry roll formula.
   * Non-numeric formulas are rounded to 2 decimals; dice rolls can show Dice So Nice.
   * @returns {Promise<{money: number, roll: Roll}|false>}
   */
  static async evaluatePaymentAmount(amount, { showDice = true } = {}) {
    const source = this.paymentRoll(amount);
    if (!source) return false;

    const roll = source._evaluated ? source : await source.evaluate();
    if (showDice && !roll.isDeterministic) {
      await DiceDSA5.showDiceSoNice(roll, game.settings.get('core', 'messageMode'));
    }

    const total = this.#isNumericRoll(roll) ? roll.total : Math.round((roll.total + Number.EPSILON) * 100) / 100;
    return total > 0 ? { money: total, roll } : false;
  }

  static async createGetPaidChatMessage(moneyString, whisper = undefined) {
    const money = this._getPaidmoney(moneyString);

    if (money) {
      const whisp = whisper ? ` (${whisper})` : '';
      const msg = `<p><b>${_loc('PAYMENT.wage')}</b></p><p>${_loc('PAYMENT.getPaidSum', { amount: await DSA5Payment._moneyToString(money) })}${whisp}</p><div class="flexrow"><button class="payButton" data-pay="1" data-amount="${money}">${_loc('PAYMENT.getPaidButton')}</button></div>`;
      ChatMessage.create(DSA5_Utility.chatDataSetup(msg, 'roll'));
    }
  }

  static async createPayChatMessage(moneyString, whisper = undefined) {
    const money = this._getPaymoney(moneyString);

    if (money) {
      const whisp = whisper ? ` (${whisper})` : '';
      const msg = `<p><b>${_loc('PAYMENT.bill')}</b></p>${_loc('PAYMENT.paySum', { amount: await DSA5Payment._moneyToString(money) })}${whisp}</p><div class="flexrow"><button class="payButton" data-pay="0" data-amount="${money}">${_loc('PAYMENT.payButton')}</button></div>`;
      ChatMessage.create(DSA5_Utility.chatDataSetup(msg, 'roll'));
    }
  }

  static parseChatCommand(content) {
    const command = content.replace(/^\/(pay|getPaid)\s*/i, '').trim();
    const separatorIndex = command.search(/\s/);

    if (separatorIndex === -1) {
      return {
        moneyString: command,
        description: undefined,
      };
    }

    const moneyString = command.slice(0, separatorIndex);
    const rawDescription = command.slice(separatorIndex).trim();
    const description = rawDescription?.match(/^\((.*)\)$/)?.[1]?.trim() || rawDescription;

    return {
      moneyString,
      description,
    };
  }

  static _getPaidmoney(moneyString, announceError = true) {
    const money = this._parseMoneyString(moneyString);

    if (!money) {
      if (announceError) {
        const msg = `<p><b>${_loc('PAYMENT.error')}</b></p><p><i>${_loc('PAYMENT.getPaidexample')}</i></p>`;
        ChatMessage.create(DSA5_Utility.chatDataSetup(msg, 'roll'));
      }
      return false;
    }
    return money;
  }

  static _getPaymoney(moneyString, announceError = true) {
    const money = this._parseMoneyString(moneyString);

    if (!money) {
      if (announceError) {
        const msg = `<p><b>${_loc('PAYMENT.error')}</b></p><p><i>${_loc('PAYMENT.payexample')}</i></p>`;
        ChatMessage.create(DSA5_Utility.chatDataSetup(msg, 'roll'));
      }
      return false;
    }
    return money;
  }

  static async handlePayAction(elem, pay, amount, actor = undefined) {
    if (game.user.isGM && !actor) {
      ui.notifications.info('PAYMENT.onlyActors', { localize: true });
      return;
    }
    if (actor) DSA5SoundEffect.playMoneySound(true);
    else actor = game.user.character;

    let result = false;
    if (actor && pay) {
      result = await DSA5Payment.payMoney(actor, amount);
    } else if (actor && !pay) {
      result = await DSA5Payment.getMoney(actor, amount);
    } else {
      ui.notifications.info('PAYMENT.onlyActors', { localize: true });
    }
    if (result && elem) {
      elem.fadeOut();
      game.socket.emit('system.dsa5', {
        type: 'updateMsg',
        payload: {
          id: elem.closest('.message').attr('data-message-id'),
          updateData: {
            [`flags.dsa5.userHidden.${game.user.id}`]: true,
          },
        },
      });
    }
  }

  static async _moneyToCoins(money, currencies = undefined) {
    const availableCurrencies = (currencies || (await DSA5_Utility.allMoneyItems()).filter((x) => x.system.subcategory != 1)).sort(
      (a, b) => b.system.price.value - a.system.price.value,
    );

    const coins = availableCurrencies.map((currency) => ({ name: currency.name, img: currency.img, value: currency.system.price.value }));
    return this.splitAmount(money, coins).map(({ name, amount, img }) => ({ name, amount, img }));
  }

  static _parseMoneyString(moneyString) {
    if (typeof moneyString === 'number') {
      return Number.isFinite(moneyString) && moneyString > 0 ? moneyString : false;
    }

    if (moneyString == null) return false;

    const normalizedMoneyString = String(moneyString).trim();
    if (!normalizedMoneyString) return false;

    const roll = this.paymentRoll(normalizedMoneyString);
    if (roll) return this.#isNumericRoll(roll) && roll.terms[0].number > 0 ? roll.terms[0].number : false;

    const match = normalizedMoneyString.replace(',', '.').match(/\d{1,}(\.\d{1,3}|,\d{1,3})?/);
    if (match) {
      return Number(match[0]);
    } else {
      return false;
    }
  }

  static _actorsMoney(actor) {
    const money = actor.items.filter((i) => i.type == 'money' && i.system.subcategory != 1);

    return {
      money: money,
      sum: money.reduce((total, current) => {
        return total + Number(current.system.quantity.value) * Number(current.system.price.value);
      }, 0.0),
    };
  }

  static async _replaceMoney(actor) {
    const money = DSA5Payment._actorsMoney(actor);
    const standardMoney = await DSA5_Utility.allMoneyItems();

    await actor.deleteEmbeddedDocuments(
      'Item',
      money.money.map((x) => x.id),
      { render: false },
    );
    await actor.createEmbeddedDocuments('Item', standardMoney, {
      render: false,
    });
    await DSA5Payment._updateMoney(actor, DSA5Payment._actorsMoney(actor).money, money.sum);
  }

  static async _updateMoney(actor, money, newSum, render = true, track = true, purpose = '') {
    const coins = await DSA5Payment._moneyToCoins(newSum, money);
    const update = [];
    let oldSum = 0;
    for (const m of money) {
      oldSum += m.system.quantity.value * m.system.price.value;
      const coin = coins.find((x) => x.name == m.name);
      if (coin == undefined) continue;

      update.push({
        _id: m.id,
        'system.quantity.value': coin.amount,
      });
    }

    await actor.updateEmbeddedDocuments('Item', update, { render });
    if (track) {
      const payload = { type: 'payment', previous: oldSum, next: newSum };
      const name = typeof purpose === 'string' ? purpose.trim() : '';
      if (name) payload.name = name;
      await MoneyTracker.track(actor, payload, newSum - oldSum);
    }
  }

  /**
   * Format a silverthaler amount as HTML with coin icons (shared by @Pay enricher and templates).
   * @param {number} money
   * @returns {Promise<string>}
   */
  static async moneyToString(money) {
    return this._moneyToString(money);
  }

  static async _moneyToString(money) {
    const coins = await DSA5Payment._moneyToCoins(money);
    const res = [];

    for (const mon of coins) {
      if (mon.amount > 0) res.push(`<span class="nobr">${mon.amount} <span data-tooltip="${mon.name}" style="background-image:url('${mon.img}')" class="chatmoney"></span></span>`);
    }

    if (res.length == 0) return '-';
    return res.join(' ');
  }

  /**
   * Format a numeric range as coin HTML, e.g. "1–3" with coin icons on each bound.
   * @param {number} min
   * @param {number} max
   * @returns {Promise<string>}
   */
  static async moneyRangeToString(min, max) {
    const [a, b] = await Promise.all([this.moneyToString(min), this.moneyToString(max)]);
    return `${a}–${b}`;
  }

  static async chatListeners(html) {
    html.on('click', '.payButton', (ev) => {
      const elem = $(ev.currentTarget);
      DSA5Payment.handlePayAction(elem, Number(elem.attr('data-pay')) != 1, elem.attr('data-amount'));
      DSA5SoundEffect.playMoneySound();
    });
  }
}
