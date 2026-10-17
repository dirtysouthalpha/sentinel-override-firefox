// popup-modules/onboarding.js (3.12.0)
// First-run onboarding flow. Triggers when chrome.storage.local doesn't
// have sentinelOnboardingDone === true. Steps through the welcome modal,
// then sets the flag so future popup loads skip past.
//
// Skip is also persisted (so it's only really first-run, never recurring).

(function() {
  const TOTAL_STEPS = 4;
  let currentStep = 1;

  function _qs(id) { 
    const element = document.getElementById(id);
    if (!element) console.warn(`Element with ID "${id}" not found`);
    return element;
  }

  function showStep(stepNumber) {
    document.querySelectorAll('.onboarding-step').forEach(el => {
      el.style.display = (parseInt(el.dataset.step, 10) === stepNumber) ? '' : 'none';
    });

    const indicator = _qs('onboardingStepIndicator');
    if (indicator) {
      indicator.textContent = `Step ${stepNumber} of ${TOTAL_STEPS}`;
    }

    const prevButton = _qs('onboardingPrevBtn');
    const nextButton = _qs('onboardingNextBtn');

    if (prevButton) {
      prevButton.style.display = stepNumber > 1 ? '' : 'none';
    }

    if (nextButton) {
      nextButton.textContent = stepNumber < TOTAL_STEPS ? 'Next →' : 'Get started';
    }

    currentStep = stepNumber;
  }

  async function markDone() {
    try {
      await chrome.storage.local.set({ sentinelOnboardingDone: true });
    } catch (error) {
      console.error('Failed to mark onboarding as done:', getErrorMessage(error));
    }

    const modal = _qs('onboarding-modal');
    if (modal) {
      modal.classList.remove('show');
    }
  }

  async function nextStep() {
    if (currentStep < TOTAL_STEPS) {
      showStep(currentStep + 1);
    } else {
      await markDone();
    }
  }

  function prevStep() {
    if (currentStep > 1) {
      showStep(currentStep - 1);
    }
  }

  // Wire buttons (defensive -- modal may not exist on some popup states)
  const nextButton = _qs('onboardingNextBtn');
  const prevButton = _qs('onboardingPrevBtn');
  const skipButton = _qs('onboardingSkipBtn');

  if (nextButton) {
    nextButton.addEventListener('click', nextStep);
  }

  if (prevButton) {
    prevButton.addEventListener('click', prevStep);
  }

  if (skipButton) {
    skipButton.addEventListener('click', markDone);
  }

  // Auto-show on first run
  (async function maybeShow() {
    try {
      const stored = await chrome.storage.local.get({ sentinelOnboardingDone: false });
      if (stored.sentinelOnboardingDone) return;

      const modal = _qs('onboarding-modal');
      if (!modal) return;

      // Small delay so the popup paints first
      setTimeout(() => {
        showStep(1);
        modal.classList.add('show');
      }, 250);
    } catch (error) {
      console.error('Error checking onboarding state:', window.getErrorMessage ? window.getErrorMessage(error) : String(error));
    }
  })();

  // Cleanup event listeners on popup unload
  if (window.addEventListener) {
    window.addEventListener('unload', () => {
      if (nextButton) nextButton.removeEventListener('click', nextStep);
      if (prevButton) prevButton.removeEventListener('click', prevStep);
      if (skipButton) skipButton.removeEventListener('click', markDone);
    });
  }
})();