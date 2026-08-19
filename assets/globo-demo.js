import { CartErrorEvent, CartLinesUpdateEvent } from '@shopify/events';

const ACTIVE_CLASS = 'gpf-demo-segmented-control__button--active';
const DEMO_SESSION_KEY = 'globo-demo:session-state';
const DEMO_LAYOUT_GUIDE_KEY = 'globo-demo:pending-layout-guide';
const DEMO_CURRENCY_DEFAULT_KEY = 'globo-demo:currency-default';
const FILTER_LAYOUTS = ['sidebar', 'horizontal', 'drawer'];
const SEARCH_LAYOUTS = ['overlay', 'two-column', 'one-column'];
const SEARCH_LAYOUT_GUIDE_STEPS = {
  'sl-two': 'two-column',
  'sl-one': 'one-column',
  'sl-over': 'overlay',
};
const LAYOUT_GUIDE_STEPS = {
  horizontal: { device: 'desktop', layout: 'horizontal', action: 'open-first-filter' },
  drawer: { device: 'desktop', layout: 'drawer', action: 'open-drawer' },
  mobile: { device: 'mobile', layout: 'sidebar', action: 'open-drawer' },
};
const LAYOUT_GUIDE_UNCHECK = { device: 'desktop', layout: 'sidebar', action: '' };

class GloboDemoControls {
  /** @param {HTMLElement} toolbar */
  constructor(toolbar) {
    this.toolbar = toolbar;
    this.root = toolbar.closest('#gpf-demo');
    this.stage = this.root?.querySelector('.gpf-demo__storefront');
    this.guide = this.root?.querySelector('#gpf-demo-guide');
    this.mobileBreakpoint = window.matchMedia('(max-width: 1179px)');
    this.guideCards = Array.from(this.root?.querySelectorAll('.gpf-demo-step[data-demo-step]') || []);
    this.guideStepConfigs = this.readGuideStepConfigs();
    this.appliedGuideAttributes = new WeakMap();
    this.guideActionBypass = new WeakSet();
    this.guideActionsInProgress = new WeakSet();
    this.activeGuideCard = null;
    this.allowLayoutNavigation = false;
    const persistedState = this.readPersistedState();
    const navigationState = this.detectNavigationState();
    const validStepIds = new Set(this.guideCards.map((card) => card.dataset.demoStep));
    const persistedSteps = Array.isArray(persistedState.doneSteps) ? persistedState.doneSteps : [];
    this.doneSteps = new Set(
      persistedSteps.filter((stepId) => validStepIds.has(stepId))
    );

    this.defaults = {
      store: toolbar.dataset.defaultStore || 'fashion',
      device: toolbar.dataset.defaultDevice || 'desktop',
      searchLayout: SEARCH_LAYOUTS.includes(toolbar.dataset.defaultSearchLayout)
        ? toolbar.dataset.defaultSearchLayout
        : 'overlay',
      guideOpen: !this.mobileBreakpoint.matches,
    };

    this.state = {
      ...this.defaults,
      store: navigationState.store || (['fashion', 'auto'].includes(persistedState.store)
        ? persistedState.store
        : this.defaults.store),
      device: this.mobileBreakpoint.matches
        ? 'mobile'
        : ['desktop', 'mobile'].includes(persistedState.device)
        ? persistedState.device
        : this.defaults.device,
      searchLayout: SEARCH_LAYOUTS.includes(persistedState.searchLayout)
        ? persistedState.searchLayout
        : this.defaults.searchLayout,
      guideOpen: typeof persistedState.guideOpen === 'boolean'
        ? persistedState.guideOpen
        : this.defaults.guideOpen,
    };

    const configuredLayout = FILTER_LAYOUTS.includes(toolbar.dataset.activeLayout)
      ? toolbar.dataset.activeLayout
      : 'sidebar';
    const currentLayout = FILTER_LAYOUTS.includes(navigationState.layout)
      ? navigationState.layout
      : configuredLayout;
    const persistedDesktopLayout = FILTER_LAYOUTS.includes(persistedState.desktopLayout)
      ? persistedState.desktopLayout
      : null;
    this.desktopLayout = this.state.device === 'mobile' && persistedDesktopLayout
      ? persistedDesktopLayout
      : currentLayout;

    if (navigationState.layout) this.toolbar.dataset.activeLayout = navigationState.layout;
    this.handleClick = this.handleClick.bind(this);
    this.handleChange = this.handleChange.bind(this);
    this.handleGuideStepCapture = this.handleGuideStepCapture.bind(this);
    this.handleViewportChange = this.handleViewportChange.bind(this);
    this.handleThemeDrawerOpen = this.handleThemeDrawerOpen.bind(this);
    this.handleThemeDrawerClose = this.handleThemeDrawerClose.bind(this);
    this.updateToolbarHeight = this.updateToolbarHeight.bind(this);
    this.toolbarResizeObserver = typeof ResizeObserver === 'function'
      ? new ResizeObserver(this.updateToolbarHeight)
      : null;
  }

  init() {
    if (!this.root) return;

    this.root.addEventListener('click', this.handleClick);
    this.root.addEventListener('change', this.handleChange);
    this.root.addEventListener('click', this.handleGuideStepCapture, true);
    this.mobileBreakpoint.addEventListener('change', this.handleViewportChange);
    document.addEventListener('theme-drawer:open', this.handleThemeDrawerOpen);
    document.addEventListener('theme-drawer:close', this.handleThemeDrawerClose);
    window.addEventListener('resize', this.updateToolbarHeight);
    this.toolbarResizeObserver?.observe(this.toolbar);

    this.updateToolbarHeight();
    const cartOpen = Boolean(document.querySelector('#cart-drawer[open]'));
    this.root.dataset.demoCartOpen = String(cartOpen);

    this.syncCollectionToggleGuideSteps();
    this.restoreGuideProgress();
    this.updateGuideProgress();
    this.render({ emit: false });
    this.runStoreCustomScript(this.state.store);
    this.runPendingLayoutGuideAction().catch((error) => {
      console.error('[globo-demo] Pending layout Guide action failed.', error);
    });
  }

  destroy() {
    this.root?.removeEventListener('click', this.handleClick);
    this.root?.removeEventListener('change', this.handleChange);
    this.root?.removeEventListener('click', this.handleGuideStepCapture, true);
    this.mobileBreakpoint.removeEventListener('change', this.handleViewportChange);
    document.removeEventListener('theme-drawer:open', this.handleThemeDrawerOpen);
    document.removeEventListener('theme-drawer:close', this.handleThemeDrawerClose);
    window.removeEventListener('resize', this.updateToolbarHeight);
    this.toolbarResizeObserver?.disconnect();
  }

  updateToolbarHeight() {
    if (!this.root || !this.toolbar) return;
    const height = Math.ceil(this.toolbar.getBoundingClientRect().height);
    this.root.style.setProperty('--gpf-demo-toolbar-height', `${height}px`);
  }

  /** @param {CustomEvent} event */
  handleThemeDrawerOpen(event) {
    const drawer = event.target instanceof Element
      ? event.target.closest('theme-drawer')
      : null;
    if (drawer?.id !== 'cart-drawer') return;

    this.root.dataset.demoCartOpen = 'true';
  }

  /** @param {CustomEvent} event */
  handleThemeDrawerClose(event) {
    const drawer = event.target instanceof Element
      ? event.target.closest('theme-drawer')
      : null;
    if (drawer?.id !== 'cart-drawer') return;

    this.root.dataset.demoCartOpen = 'false';
  }

  openGuide() {
    this.setState({ guideOpen: true });
  }

  refreshGuide() {
    this.guide = this.root?.querySelector('#gpf-demo-guide');
    this.guideCards = Array.from(this.root?.querySelectorAll('.gpf-demo-step[data-demo-step]') || []);
    this.guideStepConfigs = this.readGuideStepConfigs();
    this.appliedGuideAttributes = new WeakMap();
    this.guideActionBypass = new WeakSet();
    this.guideActionsInProgress = new WeakSet();
    this.activeGuideCard = null;

    const validStepIds = new Set(this.guideCards.map((card) => card.dataset.demoStep));
    this.doneSteps = new Set(
      Array.from(this.doneSteps).filter((stepId) => validStepIds.has(stepId))
    );

    this.syncCollectionToggleGuideSteps();
    this.restoreGuideProgress();
    this.updateGuideProgress();
    this.updateGuide(this.state.guideOpen);
    this.updateStore(this.state.store);
    this.persistState();
  }

  /** @param {MouseEvent} event */
  handleGuideStepCapture(event) {
    const card = event.target instanceof Element
      ? event.target.closest('.gpf-demo-step[data-demo-step]')
      : null;
    if (!card) return;

    if (this.guideActionBypass.has(card)) {
      this.guideActionBypass.delete(card);
      return;
    }

    if (this.activeGuideCard || this.guideActionsInProgress.has(card)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }

    if (this.mobileBreakpoint.matches && this.state.guideOpen) {
      this.setState({ guideOpen: false });
    }

    const config = this.guideStepConfigs.get(card.dataset.demoStep);
    if (this.shouldSwitchToFashionBeforeGuideAction(config)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      this.navigateGuideActionToFashion(card);
      return;
    }

    if (this.shouldReturnToFashionForGuideFilter(config)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      this.navigateGuideFilterToFashion(card);
      return;
    }

    if (config?.collectionToggle?.enabled === true) {
      event.preventDefault();
      event.stopImmediatePropagation();
      this.runCollectionToggleGuide(card, config.collectionToggle).catch((error) => {
        this.finishGuideAction(card);
        console.error('[globo-demo] Collection toggle Guide action failed.', error);
      });
      return;
    }

    const layoutGuide = LAYOUT_GUIDE_STEPS[card.dataset.demoStep];
    if (layoutGuide) {
      event.preventDefault();
      event.stopImmediatePropagation();
      const intent = this.doneSteps.has(card.dataset.demoStep)
        ? LAYOUT_GUIDE_UNCHECK
        : layoutGuide;
      this.runLayoutGuideNavigation(card, intent).catch((error) => {
        this.finishGuideAction(card);
        console.error('[globo-demo] Layout Guide navigation failed.', error);
      });
      return;
    }

    const searchLayout = SEARCH_LAYOUT_GUIDE_STEPS[card.dataset.demoStep];
    if (searchLayout) {
      event.preventDefault();
      event.stopImmediatePropagation();
      this.toggleGuideStep(card);
      this.setSearchLayout(searchLayout, true);
      return;
    }

    const guidedFocus = config?.guidedFocus;

    if (guidedFocus?.enabled === true) {
      event.preventDefault();
      event.stopImmediatePropagation();
      this.runGuidedGuideStep(card, config).catch((error) => {
        console.error('[globo-demo] Guided action failed.', error);
      });
      return;
    }

    if (config?.useClearAllFilter === true) {
      event.preventDefault();
      event.stopImmediatePropagation();
      this.runGuideStepAfterClear(card, config).catch((error) => {
        console.error('[globo-demo] Guide action failed.', error);
      });
    }
  }

  async runGuideStepAfterClear(card, config) {
    const stepId = card.dataset.demoStep;
    if (!stepId) return;

    const wasCompleted = this.doneSteps.has(stepId);
    this.startGuideAction(card);

    try {
      await this.clearFiltersBeforeGuideAction(config);

      if (wasCompleted) {
        this.toggleGuideStep(card);
      } else {
        this.clickGuideCard(card);
      }
    } finally {
      this.finishGuideAction(card);
    }
  }

  async runCollectionToggleGuide(card, collectionToggle) {
    this.startGuideAction(card);

    const activeUrl = typeof collectionToggle.activeUrl === 'string'
      ? collectionToggle.activeUrl.trim()
      : '';
    const inactiveUrl = typeof collectionToggle.inactiveUrl === 'string'
      ? collectionToggle.inactiveUrl.trim()
      : '';
    const isActive = this.isCurrentGuideUrl(activeUrl);
    const destination = isActive ? inactiveUrl : activeUrl;

    if (!destination) {
      this.finishGuideAction(card);
      return;
    }

    if (card.dataset.demoStep === 'ymm' && !isActive) {
      this.writePendingLayoutGuideAction('focus-guide-target', {
        selector: '.gf-YMM-forms',
      });
    }

    this.toggleGuideStep(card);
    document.documentElement.dataset.demoNavigationLoading = 'true';
    document.documentElement.dataset.demoLoading = 'true';

    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => window.location.assign(destination));
    });
  }

  syncCollectionToggleGuideSteps() {
    this.guideCards.forEach((card) => {
      const config = this.guideStepConfigs.get(card.dataset.demoStep);
      if (config?.collectionToggle?.enabled !== true) return;

      const activeUrl = config.collectionToggle.activeUrl;
      if (typeof activeUrl !== 'string' || !activeUrl.trim()) return;

      if (this.isCurrentGuideUrl(activeUrl)) this.doneSteps.add(card.dataset.demoStep);
      else this.doneSteps.delete(card.dataset.demoStep);
    });
  }

  isCurrentGuideUrl(url) {
    if (typeof url !== 'string' || !url.trim()) return false;

    try {
      const current = new URL(window.location.href);
      const candidate = new URL(url, window.location.href);
      const normalize = (pathname) => pathname.replace(/\/+$/, '') || '/';
      return current.origin === candidate.origin
        && normalize(current.pathname) === normalize(candidate.pathname);
    } catch (error) {
      return false;
    }
  }

  async runLayoutGuideNavigation(card, intent) {
    this.startGuideAction(card);

    const previous = { ...this.state };
    const device = intent.device === 'mobile' ? 'mobile' : 'desktop';
    const layout = FILTER_LAYOUTS.includes(intent.layout) ? intent.layout : 'sidebar';

    if (device === 'desktop') {
      this.desktopLayout = layout;
    } else {
      const currentLayout = this.toolbar.dataset.activeLayout;
      if (this.state.device !== 'mobile' && FILTER_LAYOUTS.includes(currentLayout)) {
        this.desktopLayout = currentLayout;
      }
    }

    window.globoFilterIsMobileDevice = device === 'mobile';
    this.toolbar.dataset.activeLayout = layout;
    this.state = { ...this.state, device };
    this.toggleGuideStep(card);
    this.render({ previous, emit: true });

    if (intent.action) this.writePendingLayoutGuideAction(intent.action);
    else this.removePendingLayoutGuideAction();

    const link = this.toolbar.querySelector(`[data-demo-layout-link="${layout}"]`);
    if (!(link instanceof HTMLAnchorElement) || !link.href) {
      this.removePendingLayoutGuideAction();
      this.finishGuideAction(card);
      return;
    }

    this.navigateWithSkeleton(link, layout);
  }

  writePendingLayoutGuideAction(action, detail = {}) {
    try {
      window.sessionStorage.setItem(
        DEMO_LAYOUT_GUIDE_KEY,
        JSON.stringify({ action, ...detail, createdAt: Date.now() })
      );
    } catch (error) {
      // Continue with navigation when sessionStorage is unavailable.
    }
  }

  readPendingLayoutGuideAction() {
    try {
      const stored = window.sessionStorage.getItem(DEMO_LAYOUT_GUIDE_KEY);
      const pending = stored ? JSON.parse(stored) : null;
      if (!pending || Date.now() - Number(pending.createdAt) > 15000) return null;
      return pending;
    } catch (error) {
      return null;
    }
  }

  removePendingLayoutGuideAction() {
    try {
      window.sessionStorage.removeItem(DEMO_LAYOUT_GUIDE_KEY);
    } catch (error) {
      // sessionStorage may be unavailable in privacy-restricted browsers.
    }
  }

  async runPendingLayoutGuideAction() {
    const pending = this.readPendingLayoutGuideAction();
    this.removePendingLayoutGuideAction();
    if (!pending) return;

    if (pending.action === 'run-fashion-guide-step') {
      if (this.detectNavigationState().store !== 'fashion') return;

      const stepId = typeof pending.stepId === 'string' ? pending.stepId : '';
      const card = this.guideCards.find((guideCard) => guideCard.dataset.demoStep === stepId);
      const config = this.guideStepConfigs.get(stepId);
      if (!(card instanceof HTMLElement) || !config) return;

      // render() normally applies these before pending actions run. Reapply
      // here so a Theme Editor refresh cannot replay with stale store attrs.
      this.updateGuideStepAttributes('fashion');

      if (this.guideCardUsesToggleCheckboxFilter(card)) {
        await this.waitForGuideCondition(
          () => typeof window.toggleCheckboxFilter === 'function',
          8000
        );

        if (typeof window.toggleCheckboxFilter !== 'function') return;
      }

      // Do not use clickGuideCard(): the replay must pass through the normal
      // capture dispatcher so clear, focus, collection, and checked behavior
      // stay identical to a direct click on the Fashion page.
      card.click();
      return;
    }

    if (pending.action === 'run-fashion-filter-step') {
      const stepId = typeof pending.stepId === 'string' ? pending.stepId : '';
      const card = this.guideCards.find((guideCard) => guideCard.dataset.demoStep === stepId);
      const config = this.guideStepConfigs.get(stepId);
      const filterActions = this.getGuideFilterActions(config, 'fashion');
      if (!(card instanceof HTMLElement) || filterActions.length === 0) return;

      await this.waitForGuideCondition(
        () => typeof window.toggleCheckboxFilter === 'function'
          && filterActions.some((action) => document.querySelector(action.selector)),
        8000
      );

      if (typeof window.toggleCheckboxFilter !== 'function') return;
      await this.runGuidedGuideStep(card, config);
      return;
    }

    if (pending.action === 'open-first-filter') {
      // The horizontal filter shell can exist before Globo finishes replacing
      // it with the interactive filter tree. Wait for the app's render event
      // before resolving the heading that will actually receive the click.
      await this.waitForFilterRender(6000);
      await this.waitForGuideCondition(
        () => this.getFirstHorizontalFilterHeading() instanceof HTMLElement,
        2000
      );

      const heading = this.getFirstHorizontalFilterHeading();
      const block = heading?.closest('.gf-option-block');
      if (!(heading instanceof HTMLElement) || !(block instanceof HTMLElement)) return;
      if (this.isHorizontalFilterBlockOpen(block)) return;

      await this.wait(100);
      await this.highlightAndClickGuideControl(heading, heading, 'center', 500);
      await this.waitForGuideCondition(() => this.isHorizontalFilterBlockOpen(block), 1000);
      return;
    }

    if (pending.action === 'open-drawer') {
      await this.waitForGuideCondition(
        () => Array.from(document.querySelectorAll('.gf-refine-toggle-mobile'))
          .some((element) => this.isVisibleGuideElement(element)),
        6000
      );

      if (!this.isGuideDrawerOpen()) {
        await this.wait(250);
        await this.openGuideDrawerWithHighlight('center', 500);
      }
      return;
    }

    if (pending.action === 'focus-guide-target') {
      const selector = typeof pending.selector === 'string' ? pending.selector.trim() : '';
      if (!selector) return;

      await this.waitForGuideCondition(
        () => Array.from(document.querySelectorAll(`${selector}.loaded`))
          .some((element) => this.isVisibleGuideElement(element)),
        8000
      );

      const targets = Array.from(document.querySelectorAll(`${selector}.loaded, ${selector}`));
      const target = targets.find((element) => this.isVisibleGuideElement(element));
      if (!(target instanceof HTMLElement)) return;

      await this.focusAndHighlightGuideTarget(target, 'center', 1700);
    }
  }

  async focusAndHighlightGuideTarget(target, scrollPosition, duration, phase = 'result') {
    const hadTabindex = target.hasAttribute('tabindex');
    const phaseClass = phase === 'pending'
      ? 'gpf-demo-action-highlight--pending'
      : 'gpf-demo-action-highlight--result';

    if (!target.matches('a[href], button, input, select, textarea, [tabindex]')) {
      target.setAttribute('tabindex', '-1');
    }

    target.classList.add('gpf-demo-action-highlight', phaseClass);
    this.scrollGuideElement(target, scrollPosition);

    try {
      target.focus({ preventScroll: true });
    } catch (error) {
      target.focus();
    }

    await this.wait(duration);
    target.classList.remove('gpf-demo-action-highlight', phaseClass);
    if (!hadTabindex) target.removeAttribute('tabindex');
  }

  getFirstHorizontalFilterHeading() {
    const headings = Array.from(document.querySelectorAll(
      '#gf-tree .gf-filter-contents .gf-option-block .gf-block-title .h3, '
      + '#gf-tree .gf-filter-contents .gf-option-block .gf-block-title h3'
    ));
    return headings.find((heading) => this.isVisibleGuideElement(heading)) || null;
  }

  isHorizontalFilterBlockOpen(block) {
    if (!(block instanceof HTMLElement) || block.classList.contains('is-collapsed')) return false;

    const content = block.querySelector('.gf-block-content');
    if (!(content instanceof HTMLElement)) return false;
    const style = window.getComputedStyle(content);
    const rect = content.getBoundingClientRect();
    return style.display !== 'none'
      && style.visibility !== 'hidden'
      && Number.parseFloat(style.opacity || '1') > 0
      && rect.width > 0
      && rect.height > 1;
  }

  async runGuidedGuideStep(card, config) {
    const stepId = card.dataset.demoStep;
    if (!stepId) return;

    const guidedFocus = config.guidedFocus || {};
    const wasCompleted = this.doneSteps.has(stepId);
    const originalScrollTop = window.scrollY;
    const scrollPosition = guidedFocus.scrollPosition === 'start' ? 'start' : 'center';
    const beforeDelay = this.clampGuideDelay(guidedFocus.beforeDelay, 0, 1200, 500);
    const highlightDuration = this.clampGuideDelay(guidedFocus.highlightDuration, 500, 3000, 1400);
    const selector = this.getGuideFocusSelector(config);

    this.startGuideAction(card);
    this.clearGuideHighlights();

    try {
      if (wasCompleted && config.useClearAllFilter === true) {
        await this.clearFiltersBeforeGuideAction(config);
        this.toggleGuideStep(card);
        return;
      }

      await this.clearFiltersBeforeGuideAction(config);

      const pageLayout = this.mobileBreakpoint.matches || this.state.device === 'mobile'
        ? 'drawer'
        : (this.toolbar.dataset.activeLayout || 'sidebar');
      const filterActions = this.getGuideFilterActions(config);
      const layout = pageLayout === 'drawer'
        && !this.guideStepUsesFilterDrawer(filterActions, selector)
        ? 'sidebar'
        : pageLayout;

      if (filterActions.length > 1 && typeof window.toggleCheckboxFilter === 'function') {
        await this.runGuidedFilterSequence(
          card,
          filterActions,
          layout,
          scrollPosition,
          beforeDelay,
          highlightDuration
        );
      } else {
        let target = await this.prepareGuideFocusTarget(
          selector,
          layout,
          scrollPosition,
          beforeDelay
        );

        if (target) {
          target.classList.add('gpf-demo-action-highlight', 'gpf-demo-action-highlight--pending');
          this.scrollGuideElement(target, scrollPosition);
          await this.wait(beforeDelay);
        }

        const waitsForFilter = this.guideCardUsesFilterAction(card);
        const renderCompleted = waitsForFilter ? this.waitForFilterRender(1400) : null;
        this.clickGuideCard(card);
        if (renderCompleted) await renderCompleted;
        else await this.wait(100);

        target?.classList.remove('gpf-demo-action-highlight', 'gpf-demo-action-highlight--pending');

        if (layout === 'horizontal' && filterActions.length === 1) {
          await this.waitForGuideCondition(
            () => this.queryGuideSelectedItem(filterActions[0].selector) instanceof HTMLElement,
            1600
          );
          target = this.queryGuideSelectedItem(filterActions[0].selector)
            || this.findGuideFocusTarget(selector);
        } else {
          target = this.findGuideFocusTarget(selector);
        }

        if (target) {
          await this.focusAndHighlightGuideTarget(target, scrollPosition, highlightDuration);
        }
      }

      if (guidedFocus.scrollBack === true) {
        const top = guidedFocus.scrollBackDestination === 'top' ? 0 : originalScrollTop;
        window.scrollTo({ top, behavior: this.getGuideScrollBehavior() });
      }
    } finally {
      this.clearGuideHighlights();
      this.finishGuideAction(card);
    }
  }

  async runGuidedFilterSequence(
    card,
    filterActions,
    layout,
    scrollPosition,
    beforeDelay,
    highlightDuration
  ) {
    for (const action of filterActions) {
      await this.prepareGuideFocusTarget(
        action.selector,
        layout,
        scrollPosition,
        beforeDelay
      );

      const filterOption = this.queryGuideFilterOption(action.selector);
      if (filterOption) {
        await this.focusAndHighlightGuideTarget(
          filterOption,
          scrollPosition,
          beforeDelay,
          'pending'
        );
      }

      const renderCompleted = this.waitForFilterRender(1600);
      window.toggleCheckboxFilter(action.filterName, action.value);
      await renderCompleted;

      await this.waitForGuideCondition(
        () => this.queryGuideSelectedItem(action.selector) instanceof HTMLElement,
        1600
      );

      let target = this.queryGuideSelectedItem(action.selector);

      // Some filter layouts do not render selected chips. Keep the filter
      // option itself as a fallback without taking priority over the chip.
      if (!(target instanceof HTMLElement)) {
        await this.prepareGuideFocusTarget(
          action.selector,
          layout,
          scrollPosition,
          beforeDelay
        );
        target = this.querySelectedGuideFocusElement(action.selector, true)
          || this.queryRevealedGuideFocusElement(action.selector);
      }

      if (target) {
        await this.focusAndHighlightGuideTarget(target, scrollPosition, highlightDuration);
      }
    }

    // The card's onclick contains every filter action. Calling it here would
    // run all values a second time, so only update the Guide completion state.
    this.toggleGuideStep(card);
  }

  startGuideAction(card) {
    this.activeGuideCard = card;
    this.guideActionsInProgress.add(card);
    card.setAttribute('aria-busy', 'true');
    this.toolbar.setAttribute('aria-busy', 'true');
    this.guide?.setAttribute('data-demo-action-running', 'true');

    this.guideCards.forEach((guideCard) => {
      if (guideCard !== card) guideCard.setAttribute('aria-disabled', 'true');
    });
  }

  finishGuideAction(card) {
    this.guideActionBypass.delete(card);
    this.guideActionsInProgress.delete(card);
    card.removeAttribute('aria-busy');
    if (this.activeGuideCard === card) this.activeGuideCard = null;
    this.toolbar.removeAttribute('aria-busy');
    this.guide?.removeAttribute('data-demo-action-running');
    this.guideCards.forEach((guideCard) => guideCard.removeAttribute('aria-disabled'));
  }

  clickGuideCard(card) {
    this.guideActionBypass.add(card);
    card.click();
  }

  toggleGuideCurrency(card) {
    const select = document.querySelector('.demo-store-header__country-select');
    if (!(select instanceof HTMLSelectElement)) return;

    select.focus({ preventScroll: true });

    const isUnchecking = this.doneSteps.has(card.dataset.demoStep);
    const initialValue = window.sessionStorage.getItem(DEMO_CURRENCY_DEFAULT_KEY);
    const currentCurrency = select.selectedOptions[0]?.textContent?.trim();
    const option = isUnchecking
      ? Array.from(select.options).find(({ value }) => value === initialValue)
      : Array.from(select.options).find((item) => (
        !item.disabled
        && item.value !== select.value
        && item.textContent?.trim() !== currentCurrency
      ));

    if (!option) return;

    if (isUnchecking) window.sessionStorage.removeItem(DEMO_CURRENCY_DEFAULT_KEY);
    else window.sessionStorage.setItem(DEMO_CURRENCY_DEFAULT_KEY, select.value);

    select.value = option.value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  }

  async clearFiltersBeforeGuideAction(config) {
    if (config?.useClearAllFilter !== true || typeof window.clearAllFilter !== 'function') return;

    const shouldWaitForRender = this.hasActiveGuideFilters();
    const renderCompleted = shouldWaitForRender ? this.waitForFilterRender(1400) : null;
    window.clearAllFilter();
    if (renderCompleted) await renderCompleted;
  }

  hasActiveGuideFilters() {
    return Boolean(document.querySelector(
      '.gf-option-block .checked, '
      + '.gf-option-block input:checked, '
      + '.gf-option-block [aria-checked="true"], '
      + '.globo-selected-items .selected-item, '
      + '.facets__clear-all-link--active, '
      + '.facets__clear-all--active'
    ));
  }

  guideCardUsesFilterAction(card) {
    const action = card.getAttribute('onclick') || '';
    return /(?:toggleCheckboxFilter|clearAllFilter)\s*\(/.test(action);
  }

  guideCardUsesToggleCheckboxFilter(card) {
    const action = card.getAttribute('onclick') || '';
    return /toggleCheckboxFilter\s*\(/.test(action);
  }

  getGuideFocusSelector(config) {
    const guidedFocus = config?.guidedFocus || {};
    const configuredSelector = this.state.store === 'auto'
      ? guidedFocus.autoSelector
      : guidedFocus.fashionSelector;
    if (typeof configuredSelector === 'string' && configuredSelector.trim()) {
      return configuredSelector.trim();
    }

    return this.getGuideFilterActions(config)[0]?.selector || '';
  }

  getGuideFilterActions(config, store = this.state.store) {
    const storeConfig = store === 'auto' ? config?.auto : config?.fashion;
    const actionCode = typeof storeConfig?.value === 'string' ? storeConfig.value : '';
    const pattern = /toggleCheckboxFilter\(\s*(['"])([^'"]+)\1\s*,\s*(['"])([^'"]+)\3\s*\)/g;
    const actions = [];
    let match;

    while ((match = pattern.exec(actionCode)) !== null) {
      actions.push({
        filterName: match[2],
        value: match[4],
        selector: this.getGuideValueSelector(match[4]),
      });
    }

    return actions;
  }

  shouldReturnToFashionForGuideFilter(config) {
    return this.state.store === 'auto'
      && !this.hasGuideCustomAttribute(config, 'auto')
      && this.getGuideFilterActions(config, 'fashion').length > 0;
  }

  shouldSwitchToFashionBeforeGuideAction(config) {
    return this.state.store === 'auto'
      && config?.switchToFashionBeforeAction === true;
  }

  hasGuideCustomAttribute(config, store) {
    if (config?.useCustomAttribute !== true) return false;

    const storeConfig = store === 'auto' ? config?.auto : config?.fashion;
    const name = typeof storeConfig?.name === 'string' ? storeConfig.name.trim() : '';
    const value = typeof storeConfig?.value === 'string' ? storeConfig.value.trim() : '';
    return this.isValidGuideAttribute(name) && value.length > 0;
  }

  navigateGuideFilterToFashion(card) {
    this.navigateGuideActionToFashion(
      card,
      'run-fashion-filter-step',
      this.mobileBreakpoint.matches
    );
  }

  navigateGuideActionToFashion(
    card,
    pendingAction = 'run-fashion-guide-step',
    useMobileSidebar = this.mobileBreakpoint.matches || this.state.device === 'mobile'
  ) {
    const stepId = card.dataset.demoStep;
    if (!stepId) return;

    const layout = useMobileSidebar
      ? 'sidebar'
      : (FILTER_LAYOUTS.includes(this.toolbar.dataset.activeLayout)
        ? this.toolbar.dataset.activeLayout
        : 'sidebar');
    const layoutLink = this.toolbar.querySelector(`[data-demo-layout-link="${layout}"]`);
    const destination = layoutLink instanceof HTMLAnchorElement
      ? layoutLink.dataset.fashionHref
      : '';

    if (!destination) return;

    this.startGuideAction(card);
    this.writePendingLayoutGuideAction(pendingAction, { stepId });
    this.state = {
      ...this.state,
      store: 'fashion',
      device: this.mobileBreakpoint.matches ? 'mobile' : this.state.device,
      guideOpen: false,
    };
    this.persistState();

    document.documentElement.dataset.demoNavigationLoading = 'true';
    document.documentElement.dataset.demoLoading = 'true';
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => window.location.assign(destination));
    });
  }

  guideStepUsesFilterDrawer(filterActions, selector) {
    if (filterActions.length > 0) return true;
    if (!selector) return false;

    try {
      return Array.from(document.querySelectorAll(selector)).some((element) => (
        element instanceof Element
        && Boolean(element.closest('#gf-tree, .gf-filter-contents, .gf-option-block'))
      ));
    } catch (error) {
      return false;
    }
  }

  getGuideValueSelector(value) {
    const escapedValue = typeof window.CSS?.escape === 'function'
      ? window.CSS.escape(value)
      : value.replace(/["\\]/g, '\\$&');
    return `[data-fvalue="${escapedValue}"]`;
  }

  findGuideFocusTarget(selector) {
    if (!selector) return null;

    try {
      const target = this.queryGuideFocusElement(selector);
      if (!(target instanceof HTMLElement)) return null;
      if (this.isRevealedGuideElement(target)) return target;

      const block = target.matches('.gf-option-block')
        ? target
        : target.closest('.gf-option-block');
      const heading = block?.querySelector('.gf-block-title .h3, .gf-block-title h3');
      if (heading instanceof HTMLElement && this.isVisibleGuideElement(heading)) return heading;

      const fallback = block || target.closest('.gf-filter-contents');
      if (!(fallback instanceof HTMLElement)) return null;
      return this.isVisibleGuideElement(fallback) ? fallback : null;
    } catch (error) {
      return null;
    }
  }

  async prepareGuideFocusTarget(selector, layout, scrollPosition, delay) {
    if (layout === 'drawer' && !this.isGuideDrawerOpen()) {
      await this.openGuideDrawerWithHighlight(scrollPosition, delay);
    }

    if (layout === 'horizontal' || layout === 'drawer') {
      await this.openGuideFilterBlockWithHighlight(selector, scrollPosition, delay);
    }

    return this.findGuideFocusTarget(selector);
  }

  async openGuideDrawerWithHighlight(scrollPosition, delay) {
    const triggers = Array.from(document.querySelectorAll('.gf-refine-toggle-mobile'));
    const trigger = triggers.find((element) => this.isVisibleGuideElement(element));
    if (!(trigger instanceof HTMLElement)) return;

    const clickTarget = trigger.matches('button, a')
      ? trigger
      : trigger.querySelector('button, a');
    if (!(clickTarget instanceof HTMLElement)) return;

    await this.highlightAndClickGuideControl(trigger, clickTarget, scrollPosition, delay);
    await this.waitForGuideCondition(() => this.isGuideDrawerOpen(), 900);

    const filterTree = document.querySelector('#gf-tree');
    if (filterTree instanceof HTMLElement) {
      await this.waitForGuideCondition(() => {
        const rect = filterTree.getBoundingClientRect();
        return rect.width > 0 && rect.right >= Math.min(rect.width * 0.75, 240);
      }, 700);
    }
  }

  async openGuideFilterBlockWithHighlight(selector, scrollPosition, delay) {
    const option = this.queryGuideFocusElement(selector);
    if (!(option instanceof HTMLElement)) return;

    const block = option.matches('.gf-option-block')
      ? option
      : option.closest('.gf-option-block');
    if (!(block instanceof HTMLElement)) return;

    const heading = block.querySelector('.gf-block-title .h3, .gf-block-title h3');
    if (!(heading instanceof HTMLElement)) return;

    const shouldOpen = block.classList.contains('is-collapsed')
      || !this.isRevealedGuideElement(option);
    if (!shouldOpen) return;

    await this.highlightAndClickGuideControl(heading, heading, scrollPosition, delay);
    await this.waitForGuideCondition(() => {
      const nextOption = this.queryGuideFocusElement(selector);
      return nextOption instanceof HTMLElement && this.isRevealedGuideElement(nextOption);
    }, 700);
  }

  async highlightAndClickGuideControl(highlightTarget, clickTarget, scrollPosition, delay) {
    highlightTarget.classList.add(
      'gpf-demo-action-highlight',
      'gpf-demo-action-highlight--control'
    );
    this.scrollGuideElement(highlightTarget, scrollPosition);
    await this.wait(Math.min(delay, 700));
    clickTarget.click();
    highlightTarget.classList.remove(
      'gpf-demo-action-highlight',
      'gpf-demo-action-highlight--control'
    );
  }

  queryGuideFocusElement(selector) {
    if (!selector) return null;

    try {
      const matches = Array.from(document.querySelectorAll(selector));
      return matches.find((element) => this.isRevealedGuideElement(element))
        || matches.find((element) => {
          const block = element instanceof Element ? element.closest('.gf-option-block') : null;
          const heading = block?.querySelector('.gf-block-title .h3, .gf-block-title h3');
          return heading instanceof HTMLElement && this.isVisibleGuideElement(heading);
        })
        || matches[0]
        || null;
    } catch (error) {
      return null;
    }
  }

  queryRevealedGuideFocusElement(selector) {
    if (!selector) return null;

    try {
      return Array.from(document.querySelectorAll(selector))
        .find((element) => this.isRevealedGuideElement(element)) || null;
    } catch (error) {
      return null;
    }
  }

  queryGuideFilterOption(selector) {
    if (!selector) return null;

    try {
      const matches = Array.from(document.querySelectorAll(`.gf-filter-contents ${selector}`));
      return matches.find((element) => this.isRevealedGuideElement(element))
        || matches.find((element) => this.isVisibleGuideElement(element))
        || null;
    } catch (error) {
      return null;
    }
  }

  queryGuideSelectedItem(selector) {
    if (!selector) return null;

    try {
      const matches = Array.from(document.querySelectorAll(`.globo-selected-items ${selector}`));
      return matches.find((element) => this.isRevealedGuideElement(element))
        || matches.find((element) => this.isVisibleGuideElement(element))
        || null;
    } catch (error) {
      return null;
    }
  }

  querySelectedGuideFocusElement(selector, revealedOnly = false) {
    if (!selector) return null;

    try {
      return Array.from(document.querySelectorAll(selector)).find((element) => {
        if (!(element instanceof HTMLElement)) return false;
        if (revealedOnly && !this.isRevealedGuideElement(element)) return false;

        return element.classList.contains('checked')
          || element.getAttribute('aria-checked') === 'true'
          || (element instanceof HTMLInputElement && element.checked)
          || Boolean(element.closest('li.checked'));
      }) || null;
    } catch (error) {
      return null;
    }
  }

  isGuideDrawerOpen() {
    return document.body.classList.contains('offcanvas-open')
      || document.documentElement.classList.contains('offcanvas-open')
      || Boolean(document.querySelector('.spf-has-filter.offcanvas-open'));
  }

  isVisibleGuideElement(element) {
    if (!(element instanceof HTMLElement)) return false;
    const style = window.getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0
      && rect.height > 0
      && rect.right > 0
      && rect.left < window.innerWidth;
  }

  isRevealedGuideElement(element) {
    if (!this.isVisibleGuideElement(element)) return false;
    const collapsedBlock = element.closest('.gf-option-block.is-collapsed');
    return !collapsedBlock
      || element === collapsedBlock
      || Boolean(element.closest('.gf-block-title'));
  }

  scrollGuideElement(element, block) {
    element.scrollIntoView({
      behavior: this.getGuideScrollBehavior(),
      block,
      inline: 'nearest',
    });
  }

  getGuideScrollBehavior() {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
  }

  waitForGuideCondition(condition, timeout) {
    return new Promise((resolve) => {
      const startedAt = performance.now();
      const check = () => {
        if (condition() || performance.now() - startedAt >= timeout) {
          resolve();
          return;
        }
        window.requestAnimationFrame(check);
      };
      check();
    });
  }

  clearGuideHighlights() {
    document.querySelectorAll('.gpf-demo-action-highlight').forEach((element) => {
      element.classList.remove(
        'gpf-demo-action-highlight',
        'gpf-demo-action-highlight--control',
        'gpf-demo-action-highlight--pending',
        'gpf-demo-action-highlight--result'
      );
    });
  }

  waitForFilterRender(timeout) {
    return new Promise((resolve) => {
      let settled = false;
      let settleId;
      const finish = (renderCompleted = false) => {
        if (settled) return;
        settled = true;
        window.removeEventListener('globoFilterRenderCompleted', handleRender);
        window.clearTimeout(settleId);
        window.clearTimeout(timeoutId);
        resolve(renderCompleted);
      };
      const handleRender = () => {
        window.clearTimeout(settleId);
        settleId = window.setTimeout(() => finish(true), 250);
      };
      const timeoutId = window.setTimeout(() => finish(false), timeout);
      window.addEventListener('globoFilterRenderCompleted', handleRender);
    });
  }

  wait(duration) {
    return new Promise((resolve) => window.setTimeout(resolve, duration));
  }

  clampGuideDelay(value, min, max, fallback) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.min(max, Math.max(min, number));
  }

  /** @param {Event} event */
  handleChange(event) {
    const select = event.target instanceof HTMLSelectElement
      ? event.target.closest('select[data-demo-select]')
      : null;
    if (!(select instanceof HTMLSelectElement) || !this.toolbar.contains(select)) return;

    const control = select.dataset.demoSelect;
    const value = select.value;

    if (control === 'search-layout' && SEARCH_LAYOUTS.includes(value)) {
      this.setSearchLayout(value);
      return;
    }

    if (control === 'layout' && FILTER_LAYOUTS.includes(value)) {
      const layoutLink = Array.from(this.toolbar.querySelectorAll('[data-demo-layout-link]'))
        .find((link) => link.dataset.demoLayoutLink === value);
      layoutLink?.click();
      return;
    }

    if (control === 'store' || control === 'device') {
      const matchingControl = Array.from(
        this.toolbar.querySelectorAll(`[data-demo-control="${control}"]`)
      ).find((element) => element.dataset.demoValue === value);
      matchingControl?.click();
    }
  }

  setSearchLayout(layout, openSearch = false) {
    if (!SEARCH_LAYOUTS.includes(layout)) return;

    this.setState({ searchLayout: layout });
    if (openSearch) {
      document.querySelector('.globo-search-activator')?.click();
    }
  }

  /** @param {MouseEvent} event */
  handleClick(event) {
    const target = event.target instanceof Element
      ? event.target.closest('[data-demo-control], [data-demo-action], [data-demo-layout-link], .gpf-demo-step[data-demo-step]')
      : null;
    if (!target) return;

    const control = target.dataset.demoControl;
    const value = target.dataset.demoValue;

    if (
      this.activeGuideCard
      && !this.allowLayoutNavigation
      && !target.matches('.gpf-demo-step[data-demo-step]')
      && !['close-guide', 'toggle-guide'].includes(target.dataset.demoAction)
    ) {
      event.preventDefault();
      return;
    }

    if (target.matches('.gpf-demo-step[data-demo-step]')) {
      this.toggleGuideStep(target);
      return;
    }

    if (target.matches('[data-demo-layout-link]') && !this.allowLayoutNavigation) {
      event.preventDefault();
      const layout = FILTER_LAYOUTS.includes(target.dataset.demoLayoutLink)
        ? target.dataset.demoLayoutLink
        : 'sidebar';
      const previous = { ...this.state };

      window.globoFilterIsMobileDevice = false;
      this.desktopLayout = layout;
      this.toolbar.dataset.activeLayout = layout;
      this.state = { ...this.state, device: 'desktop' };
      this.render({ previous, emit: true });
      this.navigateWithSkeleton(target, layout);
      return;
    }

    if (control && value) {
      if (control === 'device' && ['desktop', 'mobile'].includes(value)) {
        const switchingToDesktop = value === 'desktop' && this.state.device === 'mobile';
        const activatingMobileSidebar = value === 'mobile'
          && (this.state.device !== 'mobile' || this.toolbar.dataset.activeLayout !== 'sidebar');

        if (value === 'mobile' && this.state.device !== 'mobile') {
          const currentLayout = this.toolbar.dataset.activeLayout;
          if (FILTER_LAYOUTS.includes(currentLayout)) this.desktopLayout = currentLayout;
        }

        if (switchingToDesktop) {
          this.toolbar.dataset.activeLayout = FILTER_LAYOUTS.includes(this.desktopLayout)
            ? this.desktopLayout
            : 'sidebar';
        }

        window.globoFilterIsMobileDevice = value === 'mobile';

        if (value === 'mobile') {
          this.toolbar.dataset.activeLayout = 'sidebar';
          window.dispatchEvent(new CustomEvent('globoFilterRenderCompleted'));
        }

        this.setState({ [control]: value });

        if (activatingMobileSidebar) {
          const sidebarLink = this.toolbar.querySelector('[data-demo-layout-link="sidebar"]');
          this.navigateWithSkeleton(sidebarLink, 'sidebar');
        }

        if (value === 'desktop') {
          const activeLayout = this.toolbar.dataset.activeLayout || 'sidebar';
          const activeLayoutLink = this.toolbar.querySelector(
            `[data-demo-layout-link="${activeLayout}"]`
          );

          if (activeLayoutLink instanceof HTMLAnchorElement) {
            if (switchingToDesktop) {
              this.navigateWithSkeleton(activeLayoutLink, activeLayout);
            } else {
              activeLayoutLink.click();
            }
          }
        }

        return;
      }

      this.setState({ [control]: value });
      return;
    }

    switch (target.dataset.demoAction) {
      case 'reset':
        this.reset();
        break;
      case 'toggle-guide':
        if (this.state.guideOpen) {
          this.setState({ guideOpen: false });
        } else {
          this.openGuide();
        }
        break;
      case 'close-guide':
        this.setState({ guideOpen: false });
        break;
      case 'open-guide':
        this.openGuide();
        break;
    }
  }

  handleViewportChange(event) {
    if (!event.matches) return;

    const currentLayout = this.toolbar.dataset.activeLayout;
    if (this.state.device !== 'mobile' && FILTER_LAYOUTS.includes(currentLayout)) {
      this.desktopLayout = currentLayout;
    }

    window.globoFilterIsMobileDevice = true;
    this.toolbar.dataset.activeLayout = 'sidebar';
    this.setState({ device: 'mobile', guideOpen: false });
    window.dispatchEvent(new CustomEvent('globoFilterRenderCompleted'));
  }

  /** @param {Partial<typeof this.state>} patch */
  setState(patch) {
    const previous = { ...this.state };
    this.state = { ...this.state, ...patch };
    this.render({ previous, emit: true });
  }

  readPersistedState() {
    try {
      if (window.__globoDemoInitialState && typeof window.__globoDemoInitialState === 'object') {
        return window.__globoDemoInitialState;
      }

      const storedState = window.sessionStorage.getItem(DEMO_SESSION_KEY);
      const parsedState = storedState ? JSON.parse(storedState) : {};
      return parsedState && typeof parsedState === 'object' ? parsedState : {};
    } catch (error) {
      return {};
    }
  }

  detectNavigationState() {
    const currentUrl = new URL(window.location.href);
    currentUrl.hash = '';

    for (const link of this.toolbar.querySelectorAll('[data-demo-layout-link]')) {
      for (const store of ['fashion', 'auto']) {
        const href = store === 'auto' ? link.dataset.autoHref : link.dataset.fashionHref;
        if (!href) continue;

        const candidateUrl = new URL(href, window.location.href);
        candidateUrl.hash = '';
        if (candidateUrl.href === currentUrl.href) {
          return { store, layout: link.dataset.demoLayoutLink };
        }
      }
    }

    return {};
  }

  persistState() {
    try {
      const persistedState = {
        store: this.state.store,
        device: this.state.device,
        searchLayout: this.state.searchLayout,
        desktopLayout: this.desktopLayout,
        guideOpen: this.state.guideOpen,
        doneSteps: Array.from(this.doneSteps),
      };

      window.__globoDemoInitialState = persistedState;
      window.sessionStorage.setItem(
        DEMO_SESSION_KEY,
        JSON.stringify(persistedState)
      );
    } catch (error) {
      // sessionStorage may be unavailable in privacy-restricted browsers.
    }
  }

  restoreGuideProgress() {
    this.guideCards.forEach((card) => {
      const isDone = this.doneSteps.has(card.dataset.demoStep);
      card.classList.toggle('gpf-demo-step--checked', isDone);
      card.toggleAttribute('data-demo-done', isDone);
      card.setAttribute('aria-pressed', String(isDone));

      const icon = card.querySelector('.gpf-demo-step__icon .sc-interp');
      if (icon) icon.textContent = isDone ? '✓' : '';
    });
  }

  toggleGuideStep(card) {
    const stepId = card.dataset.demoStep;
    if (!stepId) return;

    const wasCompleted = this.doneSteps.has(stepId);
    const completed = !wasCompleted;

    if (completed) this.doneSteps.add(stepId);
    else this.doneSteps.delete(stepId);

    card.classList.toggle('gpf-demo-step--checked', completed);
    card.toggleAttribute('data-demo-done', completed);
    card.setAttribute('aria-pressed', String(completed));

    const icon = card.querySelector('.gpf-demo-step__icon .sc-interp');
    if (icon) icon.textContent = completed ? '✓' : '';

    this.updateGuideStepAttributes(this.state.store);

    this.updateGuideProgress();
    this.persistState();

    const detail = {
      id: stepId,
      card,
      completed,
      firstCompletion: completed && !wasCompleted,
      completedCount: this.doneSteps.size,
      totalCount: this.guideCards.length,
    };

    this.root.dispatchEvent(new CustomEvent('globo-demo:step', { bubbles: true, detail }));
  }

  updateGuideProgress() {
    const completed = this.doneSteps.size;
    const total = this.guideCards.length;
    const percent = total > 0 ? Math.round((completed / total) * 100) : 0;
    const progress = this.guide?.querySelector('[data-demo-progress]');
    const fill = progress?.querySelector('.gpf-demo-progress__fill');
    const text = this.guide?.querySelector('.gpf-demo-progress__text');
    const pillCount = this.root.querySelector('[data-demo-guide-pill-count]');

    progress?.setAttribute('aria-valuemax', String(total));
    progress?.setAttribute('aria-valuenow', String(completed));
    if (fill) fill.style.width = `${percent}%`;
    if (text) text.textContent = `${completed} / ${total}`;
    if (pillCount) pillCount.textContent = `${completed}/${total}`;
  }

  resetGuideProgress() {
    this.doneSteps.clear();
    this.guideCards.forEach((card) => {
      card.classList.remove('gpf-demo-step--checked');
      delete card.dataset.demoDone;
      card.setAttribute('aria-pressed', 'false');

      const icon = card.querySelector('.gpf-demo-step__icon .sc-interp');
      if (icon) icon.textContent = '';
    });
    this.updateGuideProgress();
  }

  reset() {
    const { guideOpen } = this.state;
    const previous = { ...this.state };
    this.resetGuideProgress();
    this.desktopLayout = 'sidebar';
    this.toolbar.dataset.activeLayout = 'sidebar';
    this.state = { ...this.defaults, store: 'fashion', guideOpen };
    this.render({ previous, emit: true, reset: true });

    const sidebarLink = this.toolbar.querySelector('[data-demo-layout-link="sidebar"]');
    const fashionSidebarHref = sidebarLink instanceof HTMLAnchorElement
      ? (sidebarLink.dataset.fashionHref || sidebarLink.href)
      : '';

    if (fashionSidebarHref) {
      const targetUrl = new URL(fashionSidebarHref, window.location.href);
      const currentUrl = new URL(window.location.href);
      targetUrl.hash = '';
      currentUrl.hash = '';

      if (targetUrl.href !== currentUrl.href) {
        window.location.assign(targetUrl.href);
        return;
      }
    }

    this.clearActiveFilters();
  }

  /** @param {{ previous?: object, emit?: boolean, reset?: boolean }} options */
  render(options = {}) {
    const { store, device, searchLayout, guideOpen } = this.state;

    this.root.dataset.demoStore = store;
    this.root.dataset.demoDevice = device;
    this.root.dataset.demoSearchLayout = device === 'mobile' ? 'overlay' : searchLayout;
    this.root.dataset.demoGuide = guideOpen ? 'open' : 'closed';

    this.updateSegment('store', store);
    this.updateSegment('device', device);
    this.updateToolbarSelect('store', store);
    this.updateToolbarSelect('device', device);
    this.updateToolbarSelect('search-layout', searchLayout);
    this.updateToolbarLinks(store);
    this.updateToolbarSelect('layout', this.toolbar.dataset.activeLayout || 'sidebar');
    this.updateLayoutAvailability(device);
    this.updateGuide(guideOpen);
    this.updateStage(device);
    this.updateStore(store);
    this.persistState();

    if (options.emit) {
      this.root.dispatchEvent(
        new CustomEvent('globo-demo:change', {
          bubbles: true,
          detail: {
            state: { ...this.state },
            previous: options.previous || null,
            reset: Boolean(options.reset),
          },
        })
      );
    }
  }

  updateSegment(control, activeValue) {
    this.toolbar.querySelectorAll(`[data-demo-control="${control}"]`).forEach((controlElement) => {
      const isActive = controlElement.dataset.demoValue === activeValue;
      controlElement.classList.toggle(ACTIVE_CLASS, isActive);

      if (controlElement instanceof HTMLAnchorElement) {
        if (isActive) controlElement.setAttribute('aria-current', 'page');
        else controlElement.removeAttribute('aria-current');
        controlElement.removeAttribute('aria-pressed');
      } else {
        controlElement.setAttribute('aria-pressed', String(isActive));
      }
    });
  }

  updateToolbarSelect(control, activeValue) {
    const select = this.toolbar.querySelector(`select[data-demo-select="${control}"]`);
    if (select instanceof HTMLSelectElement && select.value !== activeValue) {
      select.value = activeValue;
    }
  }

  updateToolbarLinks(store) {
    const hrefDatasetKey = store === 'auto' ? 'autoHref' : 'fashionHref';
    const layoutLinks = Array.from(this.toolbar.querySelectorAll('[data-demo-layout-link]'));

    layoutLinks.forEach((link) => {
      if (!(link instanceof HTMLAnchorElement)) return;
      const href = link.dataset[hrefDatasetKey];
      if (href) link.href = href;
    });

    const activeLayout = this.toolbar.dataset.activeLayout || 'sidebar';
    const activeLayoutLink = layoutLinks.find((link) => link.dataset.demoLayoutLink === activeLayout);
    if (!activeLayoutLink) return;

    layoutLinks.forEach((link) => {
      const isActive = link === activeLayoutLink;
      link.classList.toggle(ACTIVE_CLASS, isActive);
      if (isActive) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    });

    this.toolbar.querySelectorAll('[data-demo-store-link]').forEach((link) => {
      if (!(link instanceof HTMLAnchorElement)) return;
      const targetStore = link.dataset.demoStoreLink;
      const href = targetStore === 'auto'
        ? activeLayoutLink.dataset.autoHref
        : activeLayoutLink.dataset.fashionHref;
      if (href) link.href = href;
    });
  }

  updateLayoutAvailability(device) {
    this.toolbar.querySelectorAll('[data-demo-layout-link]').forEach((link) => {
      link.removeAttribute('aria-disabled');
      link.removeAttribute('tabindex');
    });
  }

  updateGuide(isOpen) {
    if (this.guide) {
      const animateMobileGuide = this.mobileBreakpoint.matches;
      this.guide.hidden = animateMobileGuide ? false : !isOpen;
      this.guide.toggleAttribute('inert', !isOpen);
      this.guide.setAttribute('aria-hidden', String(!isOpen));
    }

    const toggle = this.toolbar.querySelector('[data-demo-action="toggle-guide"]');
    toggle?.setAttribute('aria-expanded', String(isOpen));

    const label = this.toolbar.querySelector('[data-demo-guide-label]');
    if (label) {
      label.textContent = isOpen
        ? (this.toolbar.dataset.guideLabelOpen || 'Hide guide')
        : (this.toolbar.dataset.guideLabelClosed || 'Show guide');
    }

    const pill = this.root.querySelector('[data-demo-guide-pill]');
    if (pill) {
      pill.hidden = isOpen;
      pill.setAttribute('aria-expanded', String(isOpen));
    }

    const scrim = this.root.querySelector('[data-demo-guide-scrim]');
    if (scrim) {
      scrim.hidden = this.mobileBreakpoint.matches ? false : !isOpen;
      scrim.setAttribute('aria-hidden', String(!isOpen));
    }

    const progress = this.guide?.querySelector('.gpf-demo-progress__text');
    const pillCount = pill?.querySelector('[data-demo-guide-pill-count]');
    if (pillCount && progress) pillCount.textContent = progress.textContent.replace(/\s+/g, '');
  }

  updateStage(device) {
    if (!this.stage) return;
    document.documentElement.dataset.demoDevice = device;
    this.stage.setAttribute('mode', device);
    // this.stage.style.removeProperty('max-width');
  }

  navigateWithSkeleton(link, layout) {
    if (!(link instanceof HTMLAnchorElement)) return;

    const skeleton = this.stage?.querySelector('[data-demo-storefront-skeleton]');
    if (skeleton instanceof HTMLElement) {
      skeleton.classList.remove(
        'demo-storefront-skeleton--sidebar',
        'demo-storefront-skeleton--horizontal',
        'demo-storefront-skeleton--drawer'
      );
      skeleton.classList.add(`demo-storefront-skeleton--${layout}`);
      skeleton.dataset.skeletonLayout = layout;
    }

    document.documentElement.dataset.demoNavigationLoading = 'true';
    document.documentElement.dataset.demoLoading = 'true';
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        this.allowLayoutNavigation = true;
        link.click();
        this.allowLayoutNavigation = false;
      });
    });
  }

  updateStore(store) {
    this.root.querySelectorAll('[data-demo-store-only]').forEach((element) => {
      element.hidden = element.dataset.demoStoreOnly !== store;
    });

    this.updateGuideStepAttributes(store);
  }

  runStoreCustomScript(store) {
    if (!['fashion', 'auto'].includes(store)) return;

    const template = this.toolbar.querySelector(
      `template[data-demo-store-custom-js="${store}"]`
    );
    if (!(template instanceof HTMLTemplateElement)) return;

    const source = (template.content.textContent || '').trim();

    if (!source) return;

    try {
      const execute = new Function(
        'store',
        'root',
        'toolbar',
        `"use strict";\n${source}\n//# sourceURL=globo-demo-${store}-custom.js`
      );
      execute(store, this.root, this.toolbar);
    } catch (error) {
      console.error(`[globo-demo] ${store} custom JavaScript failed.`, error);
    }
  }

  updateGuideStepAttributes(store) {
    this.guideCards.forEach((card) => {
      const previousName = this.appliedGuideAttributes.get(card) || '';
      const config = this.guideStepConfigs.get(card.dataset.demoStep);
      const removeWhileChecked = config?.removeCustomAttributeWhenChecked === true
        && this.doneSteps.has(card.dataset.demoStep);
      const storeConfig = config?.useCustomAttribute === true && !removeWhileChecked
        ? (store === 'auto' ? config.auto : config.fashion)
        : null;
      const name = typeof storeConfig?.name === 'string' ? storeConfig.name.trim() : '';
      const value = typeof storeConfig?.value === 'string' ? storeConfig.value : '';

      if (previousName && previousName !== name && this.isValidGuideAttribute(previousName)) {
        card.removeAttribute(previousName);
      }

      if (this.isValidGuideAttribute(name)) {
        card.setAttribute(name, value);
        this.appliedGuideAttributes.set(card, name);
      } else {
        this.appliedGuideAttributes.delete(card);
      }
    });
  }

  readGuideStepConfigs() {
    const configs = new Map();
    this.root?.querySelectorAll('script[data-demo-guide-step-config]').forEach((script) => {
      const stepId = script.dataset.demoGuideStepConfig;
      if (!stepId) return;

      try {
        configs.set(stepId, JSON.parse(script.textContent || '{}'));
      } catch (error) {
        // Ignore invalid editor input without breaking the guide controls.
      }
    });
    return configs;
  }

  isValidGuideAttribute(name) {
    return /^[a-z_][a-z0-9_.:-]*$/i.test(name)
      && !name.toLowerCase().startsWith('data-demo-');
  }

  clearActiveFilters() {
    const clearButton = Array.from(
      this.root.querySelectorAll('.facets__clear-all-link--active, .facets__clear-all--active')
    ).find((button) => !button.closest('#filters-drawer'));

    clearButton?.click();
  }
}

function installDemoStyles() {
  if (document.getElementById('gpf-demo-runtime-style')) return;

  const style = document.createElement('style');
  style.id = 'gpf-demo-runtime-style';
  style.textContent = `
    #gpf-demo [hidden] { display: none !important; }
  `;
  document.head.append(style);
}

function initDemoControls() {
  const toolbar = document.querySelector('[data-demo-toolbar]');
  if (!(toolbar instanceof HTMLElement) || toolbar.dataset.demoReady === 'true') return;

  installDemoStyles();
  toolbar.dataset.demoReady = 'true';
  const controls = new GloboDemoControls(toolbar);
  window.globoDemoControls = controls;
  controls.init();
  requestAnimationFrame(() => document.documentElement.removeAttribute('data-demo-prepaint'));
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initDemoControls, { once: true });
} else {
  initDemoControls();
}

document.addEventListener('shopify:section:load', (event) => {
  const section = event.target instanceof Element ? event.target : null;
  const hasToolbar = section?.matches('.gpf-demo-toolbar-section')
    || section?.querySelector('[data-demo-toolbar]');
  const hasGuide = section?.matches('.gpf-demo-guide-section')
    || section?.querySelector('#gpf-demo-guide');

  if (hasToolbar) {
    window.globoDemoControls?.destroy();
    initDemoControls();
    return;
  }

  if (hasGuide && window.globoDemoControls) {
    window.globoDemoControls.refreshGuide();
    return;
  }

  if (window.globoDemoControls) {
    window.globoDemoControls.updateStore(window.globoDemoControls.state.store);
  }

  initDemoControls();
});

let activeLoadMoreButton = null;
let loadMoreLoadingTimeout = 0;

function clearLoadMoreLoadingState() {
  window.clearTimeout(loadMoreLoadingTimeout);
  loadMoreLoadingTimeout = 0;

  if (!(activeLoadMoreButton instanceof HTMLElement)) return;
  activeLoadMoreButton.classList.remove('gpf-is-loading');
  activeLoadMoreButton.removeAttribute('aria-busy');
  activeLoadMoreButton = null;
}

document.addEventListener('click', (event) => {
  const button = event.target instanceof Element
    ? event.target.closest('.gf-loadmore-btn')
    : null;
  if (!(button instanceof HTMLElement) || button.classList.contains('gpf-is-loading')) return;

  clearLoadMoreLoadingState();
  activeLoadMoreButton = button;
  button.classList.add('gpf-is-loading');
  button.setAttribute('aria-busy', 'true');
  loadMoreLoadingTimeout = window.setTimeout(clearLoadMoreLoadingState, 15000);
}, true);

window.addEventListener('globoFilterRenderCompleted', clearLoadMoreLoadingState);
window.addEventListener('pageshow', clearLoadMoreLoadingState);



// custom search
// window.addEventListener('globoFilterSearchDrawerOpened', function () {
//     const searchPopup = document.querySelector('#glFilter-search-popup');
//     const mainContent = document.querySelector('#MainContent');

//     if (!searchPopup || !mainContent) return;

//     mainContent.parentNode.insertBefore(searchPopup, mainContent);
//     setTimeout(function(){
//         document.querySelector('.gl-d-searchbox-input').focus();
//     }, 600);
// });
window.ratingCheckbox = true;
// custom card product
window.isAjaxCartEnabled = true;

const CART_DRAWER_SECTION_ID = 'cart-drawer-section';
const PRODUCT_CARD_ADD_BUTTON_SELECTOR = '.spf-product__form-btn-addtocart';
const productCardSuccessTimers = new WeakMap();
let globoCartSyncQueue = Promise.resolve();
let pendingProductCardAddButton = null;
let pendingProductCardAddTimeout = 0;

function clearPendingProductCardAdd() {
  window.clearTimeout(pendingProductCardAddTimeout);
  pendingProductCardAddTimeout = 0;
  pendingProductCardAddButton = null;
}

/** @param {HTMLElement} button */
function showProductCardAddSuccess(button) {
  if (!button.isConnected) return;

  const previousTimer = productCardSuccessTimers.get(button);
  if (previousTimer) window.clearTimeout(previousTimer);

  const originalAriaLabel = button.getAttribute('aria-label');
  button.classList.add('is-added');
  button.setAttribute('aria-label', 'Added to cart');
  button.setAttribute('aria-disabled', 'true');

  const successTimer = window.setTimeout(() => {
    button.classList.remove('is-added');
    button.removeAttribute('aria-disabled');

    if (originalAriaLabel === null) button.removeAttribute('aria-label');
    else button.setAttribute('aria-label', originalAriaLabel);

    productCardSuccessTimers.delete(button);
  }, 1000);

  productCardSuccessTimers.set(button, successTimer);
}

/** @param {HTMLElement} button */
function showProductCardAddSuccessAfterLoading(button) {
  let fallbackTimer = 0;
  const observer = new MutationObserver(() => finish());

  function cleanup() {
    observer.disconnect();
    window.clearTimeout(fallbackTimer);
  }

  function finish(force = false) {
    if (!button.isConnected) {
      cleanup();
      return;
    }
    if (!force && button.classList.contains('is-adding')) return;

    cleanup();
    showProductCardAddSuccess(button);
  }

  observer.observe(button, { attributes: true, attributeFilter: ['class'] });
  fallbackTimer = window.setTimeout(() => finish(true), 5000);

  if (!button.classList.contains('is-adding')) {
    window.requestAnimationFrame(() => finish());
  }
}

document.addEventListener('click', (event) => {
  const button = event.target instanceof Element
    ? event.target.closest(PRODUCT_CARD_ADD_BUTTON_SELECTOR)
    : null;
  if (!(button instanceof HTMLElement) || button.matches(':disabled, .is-adding, .is-added')) return;

  clearPendingProductCardAdd();
  pendingProductCardAddButton = button;
  pendingProductCardAddTimeout = window.setTimeout(clearPendingProductCardAdd, 15000);
}, true);

/**
 * Returns the added variant information when Globo includes it in the event.
 * Falls back to the first Ajax cart item because the collection card adds one
 * variant at a time.
 * @param {CustomEvent} event
 * @param {Record<string, any>} cart
 */
function getGloboAddedLine(event, cart) {
  const detail = event.detail && typeof event.detail === 'object' ? event.detail : {};
  const detailItems = Array.isArray(detail.items) ? detail.items : [];
  const candidates = [
    detail.item,
    detail.data?.item,
    detail.data,
    ...detailItems,
    detail,
    cart.items?.[0],
  ];
  const item = candidates.find((candidate) => candidate && typeof candidate === 'object') || {};
  const merchandiseId = item.merchandiseId
    ?? item.variant_id
    ?? item.variantId
    ?? item.id
    ?? cart.items?.[0]?.variant_id
    ?? cart.items?.[0]?.id
    ?? '';
  const quantity = Number(item.quantity ?? detail.quantity ?? 1);

  return {
    merchandiseId: String(merchandiseId),
    quantity: Number.isFinite(quantity) && quantity > 0 ? quantity : 1,
  };
}

async function fetchGloboCartState() {
  const cartUrl = `${Theme.routes.cart_url}.js`;
  const sectionUrl = new URL(window.location.href);
  sectionUrl.searchParams.set('section_id', CART_DRAWER_SECTION_ID);
  sectionUrl.searchParams.sort();

  const [cartResponse, sectionResponse] = await Promise.all([
    fetch(cartUrl, {
      headers: { Accept: 'application/json' },
      credentials: 'same-origin',
      cache: 'no-store',
    }),
    fetch(sectionUrl, {
      headers: { 'X-Requested-With': 'XMLHttpRequest' },
      credentials: 'same-origin',
      cache: 'no-store',
    }),
  ]);

  if (!cartResponse.ok) {
    throw new Error(`Failed to refresh cart: ${cartResponse.status}`);
  }
  if (!sectionResponse.ok) {
    throw new Error(`Failed to refresh cart drawer: ${sectionResponse.status}`);
  }

  const [cart, cartDrawerHTML] = await Promise.all([
    cartResponse.json(),
    sectionResponse.text(),
  ]);

  return { cart, cartDrawerHTML };
}

/** @param {CustomEvent} event */
async function syncGloboCartWithTheme(event) {
  const { cart, cartDrawerHTML } = await fetchGloboCartState();
  const deferredEvent = CartLinesUpdateEvent.createPromise();
  const addedLine = getGloboAddedLine(event, cart);
  const source = event.detail?.source === 'globo-quick-view'
    ? 'globo-quick-view'
    : 'globo-filter-product-card';

  document.dispatchEvent(
    new CartLinesUpdateEvent({
      action: 'add',
      context: 'product',
      lines: [addedLine],
      promise: deferredEvent.promise,
      detail: {
        source,
      },
    })
  );

  deferredEvent.resolve({
    cart: CartLinesUpdateEvent.createCartFromAjaxResponse(cart),
    detail: {
      items: cart.items,
      itemCount: cart.item_count,
      sections: {
        [CART_DRAWER_SECTION_ID]: cartDrawerHTML,
      },
      source,
      didError: false,
    },
  });
}

document.addEventListener('cart:added', function (event) {
  if (event.detail?.source !== 'globo-quick-view' && pendingProductCardAddButton) {
    const addedButton = pendingProductCardAddButton;
    clearPendingProductCardAdd();
    showProductCardAddSuccessAfterLoading(addedButton);
  }

  const syncTask = globoCartSyncQueue.then(() => syncGloboCartWithTheme(event));

  globoCartSyncQueue = syncTask.catch((error) => {
    console.error('[globo-demo] Unable to synchronize the cart UI.', error);
  });
});

document.addEventListener('shopify:cart:error', clearPendingProductCardAdd);

const QUICK_VIEW_LOADING_CLASS = 'gpf-quick-view--loading';
const pendingQuickViewAdds = new WeakSet();
let activeQuickViewTrigger = null;
let quickViewLoadingObserver = null;
let quickViewLoadingTimeout = 0;

function clearQuickViewTriggerLoading() {
  window.clearTimeout(quickViewLoadingTimeout);
  quickViewLoadingTimeout = 0;
  quickViewLoadingObserver?.disconnect();
  quickViewLoadingObserver = null;

  if (!(activeQuickViewTrigger instanceof HTMLElement)) return;
  activeQuickViewTrigger.classList.remove(QUICK_VIEW_LOADING_CLASS);
  activeQuickViewTrigger.removeAttribute('aria-busy');
  activeQuickViewTrigger = null;
}

function isQuickViewModalVisible() {
  const modal = document.querySelector('#gfqv-modal');
  if (!(modal instanceof HTMLElement) || modal.hidden) return false;

  const style = window.getComputedStyle(modal);
  const rect = modal.getBoundingClientRect();
  return style.display !== 'none'
    && style.visibility !== 'hidden'
    && Number.parseFloat(style.opacity || '1') > 0
    && rect.width > 0
    && rect.height > 0
    && modal.querySelector('.gfqv-modal-content');
}

function finishQuickViewTriggerLoadingWhenOpen() {
  if (isQuickViewModalVisible()) clearQuickViewTriggerLoading();
}

document.addEventListener('click', (event) => {
  const trigger = event.target instanceof Element
    ? event.target.closest('.open-quick-view')
    : null;
  if (!(trigger instanceof HTMLElement) || trigger.classList.contains(QUICK_VIEW_LOADING_CLASS)) return;

  clearQuickViewTriggerLoading();
  activeQuickViewTrigger = trigger;
  trigger.classList.add(QUICK_VIEW_LOADING_CLASS);
  trigger.setAttribute('aria-busy', 'true');

  quickViewLoadingObserver = new MutationObserver(finishQuickViewTriggerLoadingWhenOpen);
  quickViewLoadingObserver.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['class', 'style', 'hidden', 'open', 'aria-hidden'],
  });

  window.requestAnimationFrame(finishQuickViewTriggerLoadingWhenOpen);
  quickViewLoadingTimeout = window.setTimeout(clearQuickViewTriggerLoading, 12000);
}, true);

window.addEventListener('pageshow', clearQuickViewTriggerLoading);

/**
 * Finds the form and modal for Globo's dynamically rendered quick view.
 * @param {Element} element
 */
function getGloboQuickViewContext(element) {
  const modal = element.closest('#gfqv-modal');
  if (!modal) return null;

  const form = element.closest('form')
    || modal.querySelector('form[action*="/cart/add"]')
    || modal.querySelector('form');

  return { modal, form };
}

/**
 * Creates an Ajax cart payload while preserving variant, quantity, selling
 * plan and line-item properties from the quick-view form.
 * @param {Element} modal
 * @param {HTMLFormElement | null} form
 */
function createGloboQuickViewFormData(modal, form) {
  const formData = form ? new FormData(form) : new FormData();
  const variantControl = modal.querySelector('[name="id"]');
  const quantityControl = modal.querySelector('[name="quantity"]');

  if (!formData.get('id') && variantControl instanceof HTMLInputElement) {
    formData.set('id', variantControl.value);
  } else if (!formData.get('id') && variantControl instanceof HTMLSelectElement) {
    formData.set('id', variantControl.value);
  }

  if (!formData.get('quantity')) {
    const quantity = quantityControl instanceof HTMLInputElement ? quantityControl.value : '1';
    formData.set('quantity', quantity || '1');
  }

  return formData;
}

/**
 * Adds the selected quick-view variant without allowing the app's native form
 * submission to navigate to the cart page.
 * @param {Element} modal
 * @param {HTMLFormElement | null} form
 * @param {Element | null} trigger
 */
async function addGloboQuickViewToCart(modal, form, trigger) {
  const requestRoot = form || modal;
  if (pendingQuickViewAdds.has(requestRoot)) return;
  let addSucceeded = false;

  const formData = createGloboQuickViewFormData(modal, form);
  if (!formData.get('id')) {
    document.dispatchEvent(
      new CartErrorEvent({
        error: 'Please select a product variant.',
        code: 'INVALID',
      })
    );
    return;
  }

  const button = trigger?.matches('button, input')
    ? trigger
    : trigger?.querySelector('button, input[type="submit"]') || modal.querySelector('#gfqv-btn');
  const originalAriaLabel = button?.getAttribute('aria-label') ?? null;
  const originalInputValue = button instanceof HTMLInputElement ? button.value : '';

  pendingQuickViewAdds.add(requestRoot);
  trigger?.setAttribute('aria-busy', 'true');
  if (button instanceof HTMLButtonElement || button instanceof HTMLInputElement) {
    button.disabled = true;
    button.classList.add('gpf-demo-add-to-cart--loading');
    button.setAttribute('aria-busy', 'true');
  }

  try {
    const response = await fetch(Theme.routes.cart_add_url, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
      },
      body: formData,
      credentials: 'same-origin',
    });
    const addedItem = await response.json();

    if (!response.ok || addedItem.status) {
      throw new Error(addedItem.description || addedItem.message || 'Unable to add this item to the cart.');
    }

    addSucceeded = true;
    document.dispatchEvent(
      new CustomEvent('cart:added', {
        detail: {
          item: addedItem,
          source: 'globo-quick-view',
        },
      })
    );
  } catch (error) {
    console.error('[globo-demo] Quick-view add to cart failed.', error);
    document.dispatchEvent(
      new CartErrorEvent({
        error: error instanceof Error ? error.message : 'Unable to add this item to the cart.',
        code: 'INVALID',
      })
    );
  } finally {
    trigger?.removeAttribute('aria-busy');
    if (button instanceof HTMLButtonElement || button instanceof HTMLInputElement) {
      button.classList.remove('gpf-demo-add-to-cart--loading');
      button.removeAttribute('aria-busy');

      if (addSucceeded) {
        button.classList.add('gpf-demo-add-to-cart--added');
        button.setAttribute('aria-label', 'Added to cart');
        if (button instanceof HTMLInputElement) button.value = '✓';

        window.setTimeout(() => {
          button.classList.remove('gpf-demo-add-to-cart--added');
          button.disabled = false;

          if (originalAriaLabel === null) button.removeAttribute('aria-label');
          else button.setAttribute('aria-label', originalAriaLabel);
          if (button instanceof HTMLInputElement) button.value = originalInputValue;

          pendingQuickViewAdds.delete(requestRoot);
        }, 1000);
      } else {
        button.disabled = false;
        pendingQuickViewAdds.delete(requestRoot);
      }
    } else {
      pendingQuickViewAdds.delete(requestRoot);
    }
  }
}

document.addEventListener('click', function (event) {
  const trigger = event.target instanceof Element
    ? event.target.closest('#gfqv-btn-wrap, #gfqv-btn')
    : null;
  if (!trigger) return;

  const context = getGloboQuickViewContext(trigger);
  if (!context) return;

  event.preventDefault();
  event.stopImmediatePropagation();
  addGloboQuickViewToCart(context.modal, context.form, trigger);
}, true);

document.addEventListener('submit', function (event) {
  const form = event.target instanceof HTMLFormElement ? event.target : null;
  if (!form || !form.closest('#gfqv-modal')) return;
  if (!form.querySelector('#gfqv-btn-wrap, #gfqv-btn') && !form.matches('[action*="/cart/add"]')) return;

  const context = getGloboQuickViewContext(form);
  if (!context) return;

  event.preventDefault();
  event.stopImmediatePropagation();
  addGloboQuickViewToCart(context.modal, context.form, form.querySelector('#gfqv-btn-wrap, #gfqv-btn'));
}, true);
