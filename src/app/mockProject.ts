import type { StudioProject } from '../features/timeline/types';

export const mockProject: StudioProject = {
  title: '仙侠奇缘 第01集',
  sourceLanguage: 'zh',
  targetLanguage: 'vi',
  durationMs: 45 * 60 * 1000 + 23 * 1000,
  speakers: [
    { id: 'lin', name: '林婉儿', roleZh: '女主', gender: 'Nữ', share: 28, accent: 'violet', initials: 'LW' },
    { id: 'ye', name: '夜无痕', roleZh: '男主', gender: 'Nam', share: 35, accent: 'blue', initials: 'YW' },
    { id: 'mo', name: '墨无极', roleZh: '反派', gender: 'Nam', share: 22, accent: 'green', initials: 'MW' },
  ],
  segments: [
    { id: 's1', speakerId: 'lin', startMs: 0, endMs: 7000, sourceText: '你终于来了', translatedText: 'Cuối cùng chàng cũng đến.' },
    { id: 's2', speakerId: 'lin', startMs: 8000, endMs: 16000, sourceText: '你终于来了，我等你很久了。', translatedText: 'Cuối cùng chàng cũng đến, ta đã đợi chàng rất lâu rồi.' },
    { id: 's3', speakerId: 'ye', startMs: 17000, endMs: 26000, sourceText: '发生了什么事？', translatedText: 'Chuyện gì đã xảy ra?' },
    { id: 's4', speakerId: 'ye', startMs: 27000, endMs: 36500, sourceText: '我们必须尽快离开这里', translatedText: 'Chúng ta phải rời khỏi đây nhanh.' },
    { id: 's5', speakerId: 'mo', startMs: 37500, endMs: 45200, sourceText: '好，我跟你们一起走。', translatedText: 'Được, ta đi cùng các người.' },
  ],
};
