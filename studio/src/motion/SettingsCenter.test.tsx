// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it } from 'vitest';
import readme from '../../../README.md?raw';
import chineseReadme from '../../../README.zh-CN.md?raw';
import { I18nProvider } from '../i18n/I18n';
import { savedFollowUpBehavior, setFollowUpBehavior } from '../utils/superAgentPreferences';
import { SettingsCenter } from './SettingsCenter';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  localStorage.removeItem('hf-studio-ui-preferences');
  setFollowUpBehavior('steer');
});

it.each([
  { locale: 'zh-CN', heading: '社群', labels: ['飞书群', 'Discord'], document: chineseReadme },
  { locale: 'en', heading: 'Community', labels: ['Discord', 'Feishu group'], document: readme },
] as const)('offers both README invitations in locale order from Help in $locale', ({ locale, heading, labels, document }) => {
  const html = renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>
      <SettingsCenter section="help" onSection={() => {}} openConnections={() => {}} />
    </I18nProvider>,
  );
  const page = new DOMParser().parseFromString(html, 'text/html');
  const section = page.querySelector('section[aria-labelledby="om-community-heading"]');
  expect(section?.querySelector('h2')?.textContent).toBe(heading);
  const links = Array.from(section!.querySelectorAll('a'));
  expect(links.map(link => link.textContent)).toEqual(labels);
  for (const link of links) {
    expect(document).toContain(`href="${link.href}"`);
    expect(link.target).toBe('_blank');
    expect(link.relList.contains('noopener')).toBe(true);
  }
});

it('renders Follow-up behavior in General settings defaulting to Steer and persists Queue changes', async () => {
  localStorage.removeItem('hf-studio-ui-preferences');
  expect(savedFollowUpBehavior()).toBe('steer');

  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(
        <I18nProvider initialLocale="en">
          <SettingsCenter section="general" onSection={() => {}} openConnections={() => {}} />
        </I18nProvider>,
      );
    });

    expect(container.textContent).toContain('Follow-ups');
    const trigger = container.querySelector<HTMLElement>('[role="combobox"][aria-label="Follow-up behavior"]')!;
    expect(trigger).toBeTruthy();
    expect(trigger.textContent).toContain('Steer');

    await act(async () => trigger.click());
    const queueOption = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
      el => el.textContent?.includes('Queue'),
    )!;
    expect(queueOption).toBeTruthy();
    await act(async () => queueOption.click());

    expect(savedFollowUpBehavior()).toBe('queue');
    expect(trigger.textContent).toContain('Queue');
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});
