// Native settings provide one language for the menu, windows and web content.
export const desktopMessages = {
  en: {
    controlTitle: 'Araneae · Control Panel',
    petTitle: 'Araneae Desktop Companion',
    petArea: 'Desktop companion walking area',
    controlsLabel: 'Desktop companion controls',
    behavior: 'Behavior',
    modesLabel: 'Behavior modes',
    roam: 'Patrol',
    follow: 'Follow Pointer',
    observe: 'Observe',
    speed: 'Speed',
    size: 'Size',
    allowCrossScreen: 'Allow Cross-Display Movement',
    pause: 'Pause Ⅱ',
    resume: 'Resume ▷',
    hide: 'Hide Spider',
    show: 'Show Spider',
    command: '⌘ Command + click',
    noteBefore: 'Hold ',
    noteAfter: ' to dash to a destination. When cross-display movement is off, clicks, patrol and following stay on the spider’s current display. Commands are ignored while paused or hidden.',
    connecting: 'Connecting to the companion…',
    hiddenStatus: 'The spider is hidden. You can show it again at any time.',
    pausedStatus: 'Paused. Resume to restore movement and click commands.',
    readyStatus: 'Command-click to dash. Your mouse continues to work in other apps.',
    operationFailed: 'Could not complete the operation: ',
    petFailed: 'The companion encountered a problem. Quit Araneae from the eyes icon in the menu bar, then reopen it. ',
  },
  'zh-CN': {
    controlTitle: 'Araneae · 控制面板',
    petTitle: 'Araneae 桌宠',
    petArea: '桌宠爬行区域',
    controlsLabel: '桌宠控制面板',
    behavior: '行为控制',
    modesLabel: '行为模式',
    roam: '自主巡逻',
    follow: '跟随鼠标',
    observe: '原地观察',
    speed: '爬行速度',
    size: '身体大小',
    allowCrossScreen: '允许跨屏',
    pause: '暂停 Ⅱ',
    resume: '继续 ▷',
    hide: '隐藏蜘蛛',
    show: '显示蜘蛛',
    command: '⌘ Command + 单击',
    noteBefore: '按住 ',
    noteAfter: '，冲刺前往。关闭允许跨屏后，仅响应蜘蛛所在屏幕的点击，巡逻和跟随也限定在该屏幕。暂停或隐藏时不响应。',
    connecting: '正在连接桌宠…',
    hiddenStatus: '蜘蛛已隐藏，可随时重新显示。',
    pausedStatus: '已暂停，继续后恢复活动和点击互动。',
    readyStatus: '⌘ Command + 单击冲刺前往，鼠标可正常操作其他应用。',
    operationFailed: '操作未完成：',
    petFailed: '桌宠运行遇到问题。请从菜单栏的 Araneae 小眼睛图标退出后重新打开。',
  },
};

export function desktopStrings(language = 'en', platform = 'macos') {
  const strings = desktopMessages[language] ?? desktopMessages.en;
  if (platform !== 'windows') return strings;
  const chinese = language === 'zh-CN';
  return {...strings,
    command: chinese ? 'Ctrl + 单击' : 'Ctrl + click',
    readyStatus: chinese ? 'Ctrl + 单击冲刺前往，鼠标可正常操作其他应用。'
      : 'Ctrl-click to dash. Your mouse continues to work in other apps.',
    petFailed: chinese ? '桌宠运行遇到问题。请从系统托盘的 Araneae 小眼睛图标退出后重新打开。'
      : 'The companion encountered a problem. Quit Araneae from the eyes icon in the system tray, then reopen it. ',
  };
}

export function localizeDesktop(document, language, platform) {
  const strings = desktopStrings(language, platform);
  document.documentElement.lang = language === 'zh-CN' ? 'zh-CN' : 'en';
  document.querySelectorAll('[data-i18n]').forEach(element => {
    element.textContent = strings[element.dataset.i18n];
  });
  document.querySelectorAll('[data-i18n-label]').forEach(element => {
    element.setAttribute('aria-label', strings[element.dataset.i18nLabel]);
  });
  return strings;
}
