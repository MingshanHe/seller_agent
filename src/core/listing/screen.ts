// 上架前的规则筛查。规则写在代码里，不依赖模型判断。
import type { RiskFlag, RiskLevel, SourceProduct } from '../types.ts';

const RULES: { pattern: RegExp; level: RiskLevel; reason: string }[] = [
  { pattern: /高仿|原单|A货|复刻|1:1|一比一/i, level: 'block', reason: '疑似仿冒商品' },
  { pattern: /电池|锂电|充电宝|移动电源|充电器|适配器|插头/, level: 'review', reason: '可能需要 PSE / PSC 认证' },
  { pattern: /无线|蓝牙|wi-?fi|对讲机|遥控/i, level: 'review', reason: '可能需要技適认证' },
  { pattern: /化妆品|面霜|口红|精华液|粉底|面膜|香水/, level: 'review', reason: '化妆品属于日本站制限类目' },
  { pattern: /食品|零食|茶叶|保健品|咖啡豆/, level: 'review', reason: '食品属于日本站制限类目' },
  { pattern: /医用|医疗|血压计|体温计|隐形眼镜/, level: 'review', reason: '医疗用品属于日本站制限类目' },
  { pattern: /婴儿|奶瓶|童车|安全座椅/, level: 'review', reason: '婴幼儿用品属于日本站制限类目' },
  { pattern: /宠物/, level: 'review', reason: '宠物用品属于日本站制限类目' },
  { pattern: /盲盒/, level: 'review', reason: '盲盒属于日本站制限类目' },
  { pattern: /白酒|啤酒|葡萄酒/, level: 'review', reason: '酒类属于日本站制限类目' },
  { pattern: /二手|中古/, level: 'review', reason: '二手商品属于日本站制限类目' },
  { pattern: /SIM\s?卡/i, level: 'review', reason: 'SIM 卡属于日本站制限类目' },
  { pattern: /轮胎|汽车|摩托车/, level: 'review', reason: '汽车和轮胎属于日本站制限类目' },
  { pattern: /珠宝|钻石|黄金/, level: 'review', reason: '珠宝属于日本站制限类目' },
  { pattern: /nike|adidas|gucci|chanel|louis vuitton|disney|迪士尼|三丽鸥|hello kitty|apple|苹果/i, level: 'review', reason: '含知名品牌词，需确认授权' },
];

export function screenSource(source: Pick<SourceProduct, 'title' | 'description' | 'attributes'>): RiskFlag[] {
  const text = [source.title, source.description, ...source.attributes.map((a) => `${a.name} ${a.value}`)].join('\n');
  const seen = new Set<string>();
  const flags: RiskFlag[] = [];
  for (const rule of RULES) {
    if (rule.pattern.test(text) && !seen.has(rule.reason)) {
      seen.add(rule.reason);
      flags.push({ level: rule.level, reason: rule.reason });
    }
  }
  return flags;
}

export function overallRisk(flags: RiskFlag[]): RiskLevel {
  if (flags.some((f) => f.level === 'block')) return 'block';
  if (flags.some((f) => f.level === 'review')) return 'review';
  return 'pass';
}

// 这些字只出现在简体中文里，日语不用，可以用来发现漏翻的中文。
// 机、号、学、与、后、云这类日语也用的字故意不放进来。
const SIMPLIFIED_ONLY = new RegExp('[' + [
  '这们说为对开关门问题发现实际质产货颜码时间设计无专业优价购买卖适运输页图标电线网东长车',
  '锈钢铁铝铜银锅锁键镜钟钮销绿红蓝纯细织给经结绝统维罗组终绍继续练纸绳',
  '个从么吗让气压岁单带态总华软轻较办务动劳势历县变听员围园圆场坏块处备复够头',
  '夹奖妇宽导层师帮广应庆库废张弹强录忆战户扩扫报护拟择挂换显晓书术杀权极构样',
  '树桥检欢汉汤沟洁测济灭灵热爱环疗盐监盖盘础确种积稳笔简类粮职联胶脑舰艺节获',
  '药虽补见观规视览觉订认讨议记许论证评识诉词试话语请读课调谈负责贝贵费资赠转',
  '轮边达过还进远连选递邮闭闲阅队阶阳阴陆陈难雾顶项顺须预领频颗风飞饭饮馆马验',
  '鱼鸟鸡龙',
].join('') + ']', 'g');

export function simplifiedChineseHits(text: string): string[] {
  return [...new Set(text.match(SIMPLIFIED_ONLY) ?? [])];
}

// 商品文字里不能出现站外联系方式，货源网页也可能借此把买家引走。
const CONTACT_PATTERNS: [RegExp, string][] = [
  [/https?:\/\/|www\./i, '网址'],
  [/[\w.+-]+@[\w-]+\.[a-z]{2,}/i, '邮箱'],
  [/(?<!\d)0\d{1,3}[-\s]\d{2,4}[-\s]\d{3,4}(?!\d)/, '电话'],
  [/(?<!\d)1[3-9]\d{9}(?!\d)/, '电话'],
  [/LINE\s*(ID|公式|追加)|ライン\s*(ID|追加)|wechat|微信|weixin|QQ\s*\d/i, '站外联系方式'],
];

export function contactHits(text: string): string[] {
  return [...new Set(CONTACT_PATTERNS.filter(([re]) => re.test(text)).map(([, label]) => label))];
}
