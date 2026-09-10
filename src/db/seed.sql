-- 種子資料：對應規格 §2.1 的實體版面
-- 黑板：全週固定職務 2 項、每日輪替職務 3 項
-- 白板：早修 10 點位、午休 10 點位，每點 2~3 人

INSERT INTO location_tasks (board_type, shift_type, item_name, required_capacity, sort_order) VALUES
  ('BLACKBOARD', 'ALL_WEEK', '交接',     1, 10),
  ('BLACKBOARD', 'ALL_WEEK', '值日生',   1, 20),
  ('BLACKBOARD', 'DAILY',    '餐車',     1, 30),
  ('BLACKBOARD', 'DAILY',    '早修升旗', 1, 40),
  ('BLACKBOARD', 'DAILY',    '午休回來', 1, 50),

  ('WHITEBOARD', 'MORNING', '育英樓',   3, 10),
  ('WHITEBOARD', 'MORNING', '教大',     3, 20),
  ('WHITEBOARD', 'MORNING', '7-11',     2, 30),
  ('WHITEBOARD', 'MORNING', '正門',     3, 40),
  ('WHITEBOARD', 'MORNING', '後門',     2, 50),
  ('WHITEBOARD', 'MORNING', '活動中心', 2, 60),
  ('WHITEBOARD', 'MORNING', '圖書館',   2, 70),
  ('WHITEBOARD', 'MORNING', '體育館',   2, 80),
  ('WHITEBOARD', 'MORNING', '川堂',     3, 90),
  ('WHITEBOARD', 'MORNING', '側門',     2, 100),

  ('WHITEBOARD', 'NOON', '育英樓',   3, 10),
  ('WHITEBOARD', 'NOON', '教大',     2, 20),
  ('WHITEBOARD', 'NOON', '7-11',     2, 30),
  ('WHITEBOARD', 'NOON', '正門',     3, 40),
  ('WHITEBOARD', 'NOON', '後門',     2, 50),
  ('WHITEBOARD', 'NOON', '活動中心', 3, 60),
  ('WHITEBOARD', 'NOON', '圖書館',   2, 70),
  ('WHITEBOARD', 'NOON', '體育館',   2, 80),
  ('WHITEBOARD', 'NOON', '川堂',     2, 90),
  ('WHITEBOARD', 'NOON', '側門',     2, 100);

INSERT INTO staff (name) VALUES
  ('王雅琳'), ('林建宏'), ('陳怡君'), ('張家豪'), ('李明哲'), ('黃詩涵'),
  ('吳秉翰'), ('劉宛庭'), ('蔡承恩'), ('鄭曉薇'), ('謝俊傑'), ('許雅文'),
  ('洪志偉'), ('曾佳蓉'), ('高柏翰'), ('潘映竹'), ('簡文彬'), ('賴思妤'),
  ('周冠廷'), ('葉淑芬'), ('莊子敬'), ('邱瑋倫'), ('廖若涵'), ('江家瑜'),
  ('沈品瑄'), ('杜宗翰'), ('馮郁婷'), ('唐立群'), ('石佩珊'), ('孫振豪'),
  ('傅美玲'), ('程冠宇'), ('溫思穎'), ('尤柏勳'), ('范秀琴'), ('鍾岱樺');

INSERT INTO fairness_stats (staff_id, blackboard_count, morning_whiteboard_count, noon_whiteboard_count)
  SELECT staff_id, 0, 0, 0 FROM staff;
