const TIME_PATTERN = /(?:今天|明天|后天|今晚|今早|本周|下周|这周|周[一二三四五六日天]|星期[一二三四五六日天]|月底|月初|上午|下午|中午|晚上|凌晨|早上|\d{1,2}\s*(?:点|时|:|：)(?:\s*\d{1,2}\s*分?)?|\d{1,2}\s*月\s*\d{1,2}\s*[日号]|\d{4}\s*[年/-]\s*\d{1,2}\s*[月/-]\s*\d{1,2})/i;
const REMINDER_PATTERN = /(?:提醒我|提醒一下|记得|别忘|不要忘|待办|todo|日程|安排|预约|截止|到期|闹钟|叫我|通知我)/i;
const ACTION_PATTERN = /^(?:请)?\s*(?:去|要|需要|准备|完成|提交|联系|回复|购买|买|取|寄|缴|交|打电话|开会|预约|办理|检查|复习|写|做)\s*/;

export function needsAiAnalysis(text='') {
  const value=String(text).trim();
  return TIME_PATTERN.test(value) || REMINDER_PATTERN.test(value) || ACTION_PATTERN.test(value);
}

export function inferIdeaTheme(text='') {
  const value=String(text);
  const themes=[
    ['工作',/(?:工作|项目|客户|同事|会议|方案|业务|公司|产品|运营)/],
    ['学习',/(?:学习|复习|考试|数学|英语|知识|课程|读书|学校|作业)/],
    ['创作',/(?:创作|视频|文案|选题|拍摄|设计|灵感|文章|脚本|画面)/],
    ['生活',/(?:生活|家里|孩子|吃饭|睡觉|运动|旅行|心情|家庭|健康)/],
  ];
  return themes.find(([,pattern])=>pattern.test(value))?.[0] || '其他';
}

export function directIdeaFrom(text,{id,createdAt}) {
  const content=String(text).trim();
  const oneLine=content.replace(/\s+/g,' ');
  return {
    id,
    title:oneLine.slice(0,36) || '未命名灵感',
    content,
    theme:inferIdeaTheme(content),
    createdAt,
    source:content,
  };
}
