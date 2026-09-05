import type { StudioProject } from '../features/timeline/types';
export const mockProject: StudioProject = {
  id: 'demo', title: 'Tiên Hiệp Kỳ Duyên · Tập 01', durationMs: 2723000, sourceLanguage: 'zh', targetLanguage: 'vi',
  speakers: [
    { id: 'lin', name: 'Lâm Uyển Nhi', label: 'Nữ chính', share: 43 },
    { id: 'ye', name: 'Dạ Vô Ngân', label: 'Nam chính', share: 35 },
    { id: 'mo', name: 'Mặc Vô Cực', label: 'Phản diện', share: 22 },
  ],
  segments: [
    { id: 's1', speakerId: 'lin', startMs: 923000, endMs: 927500, sourceText: '你终于来了，我等你很久了。', translatedText: 'Cuối cùng chàng cũng đến, ta đã đợi chàng rất lâu rồi.' },
    { id: 's2', speakerId: 'ye', startMs: 928000, endMs: 932000, sourceText: '发生了什么事？', translatedText: 'Chuyện gì đã xảy ra?' },
    { id: 's3', speakerId: 'mo', startMs: 933000, endMs: 938000, sourceText: '我们必须尽快离开这里。', translatedText: 'Chúng ta phải rời khỏi đây thật nhanh.' },
  ],
};
