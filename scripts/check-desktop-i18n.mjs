import {test} from 'node:test';
import assert from 'node:assert/strict';
import {detectPlatform, desktopStrings} from '../dist/desktop-i18n.js';

test('detectPlatform recognizes Windows, macOS, and fallback user agents', () => {
  assert.equal(detectPlatform('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'), 'windows');
  assert.equal(detectPlatform('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15'), 'macos');
  assert.equal(detectPlatform('Mozilla/5.0 (X11; Linux x86_64)'), 'other');
  assert.equal(detectPlatform(''), 'other');
});

test('Windows copy uses Ctrl + click and system tray in both English and Simplified Chinese', () => {
  const en = desktopStrings('en', 'windows');
  assert.equal(en.command, 'Ctrl + click');
  assert.match(en.readyStatus, /Ctrl-click/);
  assert.match(en.petFailed, /system tray/);
  assert.doesNotMatch(en.petFailed, /menu bar/);

  const zh = desktopStrings('zh-CN', 'windows');
  assert.equal(zh.command, 'Ctrl + 单击');
  assert.match(zh.readyStatus, /Ctrl \+ 单击/);
  assert.match(zh.petFailed, /系统托盘/);
  assert.doesNotMatch(zh.petFailed, /菜单栏/);
});

test('macOS copy preserves Command + click and menu bar wording', () => {
  const en = desktopStrings('en', 'macos');
  assert.equal(en.command, '⌘ Command + click');
  assert.match(en.petFailed, /menu bar/);

  const zh = desktopStrings('zh-CN', 'macos');
  assert.equal(zh.command, '⌘ Command + 单击');
  assert.match(zh.petFailed, /菜单栏/);
});
