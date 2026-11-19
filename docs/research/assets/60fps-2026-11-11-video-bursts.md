# 영상 움직임 버스트 측정 원자료(2026-11-11, 전부 추정치)

> 방법: 60fps 상세의 메인 영상(gumlet main.mp4)을 96px 폭 회색조 프레임으로 줄여 프레임 간 |차이|>10인 화소 수를 셈. 임계 = max(4, 3×중앙값+1), 간격 5프레임 이내 병합, 3프레임 미만 버림(조사용 임시 스크립트). 버스트 = 화면이 움직인 연속 구간 길이(ms). 손가락·스크롤·키보드 이동이 섞인 **상한**이다. 보정: N012(코드 spring .36/.92, t99 312ms)의 영상 버스트가 280–360ms → "버스트 ≈ t99 ± 1프레임"으로 읽는다. 15fps 영상은 ±67ms 오차.

| 파일 | 사례 | fps | 길이(s) | 버스트 수 | 중앙값(ms) | 버스트 [시작 s, 길이 ms] |
|---|---|---|---|---|---|---|
| a091.mp4 | A091 Mike Barton Swipe Boarding Pass to Enter Interaction | 60 | 4.0 | 3 | 483 | 0.1s·767; 1.05s·483; 2.35s·117 |
| a092.mp4 | A092 OpenAI Dots Intro Mascot Animation | 60 | 14.8 | 9 | 383 | 0.43s·1350; 3.22s·1400; 5.52s·1500; 8.1s·383; 8.85s·333; 9.62s·100; 10.07s·150; 10.98s·283; 12.88s·1333 |
| a093.mp4 | A093 Graphical Header Pill Tap Interaction | 60 | 9.8 | 11 | 183 | 0.1s·100; 0.82s·183; 1.5s·100; 2.47s·133; 3.23s·117; 4.15s·183; 5.02s·117; 5.85s·200; 6.73s·200; 7.63s·183; 8.5s·183 |
| a095.mp4 | A095 Apple Safari 3D Perspective Logo Animation | 60 | 6.0 | 4 | 817 | 0.1s·817; 1.07s·1117; 2.33s·617; 3.5s·417 |
| a096.mp4 | A096 Apple HomeView Zoom Scroll Interaction | 60 | 4.3 | 2 | 700 | 0.48s·117; 1.4s·700 |
| S1015.mp4 | S1015 Grok Chat Menu Interaction | 60 | 2.9 | 1 | 433 | 0.5s·433 |
| S1167.mp4 | S1167 Toss Accept Terms Check Interaction | 60 | 4.7 | 4 | 617 | 0.1s·333; 1.63s·783; 2.95s·117; 4.07s·617 |
| S1220.mp4 | S1220 Toss OTP Successful Animation | 60 | 5.3 | 3 | 233 | 2.57s·350; 3.65s·233; 4.0s·200 |
| S1300.mp4 | S1300 Honk Delete Account Sheet Stack Interaction | 15 | 3.1 | 2 | 800 | 0.47s·733; 1.87s·800 |
| S1317.mp4 | S1317 Honk Chat Bubble Dynamic Resize Back and Forth Interaction | 15 | 13.2 | 5 | 733 | 0.4s·667; 1.73s·267; 3.87s·1000; 6.87s·3467; 11.33s·733 |
| S1365.mp4 | S1365 Family Button to Sheet Button Morph Interaction | 60 | 3.6 | 3 | 167 | 0.58s·417; 2.3s·100; 2.5s·167 |
| S1375.mp4 | S1375 Family Dynamic Sheet Morph Interaction | 60 | 4.5 | 7 | 233 | 0.27s·50; 0.43s·250; 1.47s·50; 1.63s·250; 2.63s·250; 3.88s·67; 4.05s·233 |
| S1391.mp4 | S1391 Family Contextual Spinner Move to Sheet Morph Interaction | 60 | 8.3 | 10 | 150 | 0.35s·83; 0.55s·283; 1.2s·67; 1.38s·150; 1.78s·67; 2.57s·83; 2.75s·133; 3.88s·733; 4.75s·633; 8.18s·150 |
| S1402.mp4 | S1402 Family Entering Values to Confirm Screen Morph Interaction | 60 | 4.0 | 2 | 533 | 0.52s·400; 2.67s·533 |
| S1455.mp4 | S1455 Uber Ride Verified Tick in Sheet Animation | 60 | 2.6 | 2 | 350 | 0.48s·333; 1.6s·350 |
| S1476.mp4 | S1476 Google AI Mode Search Morph Interaction | 60 | 7.0 | 4 | 433 | 1.47s·450; 3.02s·317; 3.9s·433; 5.55s·317 |
| S1484.mp4 | S1484 Cobot Toast Expand Shrink Interaction | 60 | 4.0 | 1 | 1200 | 1.43s·1200 |
| S1541.mp4 | S1541 Grok Pull Down to Go Back Interaction | 60 | 7.8 | 4 | 1133 | 0.4s·500; 1.67s·1650; 4.38s·500; 5.95s·1133 |
| S1564.mp4 | S1564 Perplexity Model Selection Sheet Morph Interaction | 60 | 16.6 | 12 | 367 | 0.42s·400; 1.83s·367; 5.43s·350; 6.75s·367; 8.3s·350; 9.85s·333; 10.52s·367; 11.25s·383; 12.52s·417; 13.58s·67; 14.88s·233; 15.45s·367 |
| S1586.mp4 | S1586 Swiggy Purchased Loader to Check Mark Animation | 60 | 3.1 | 2 | 300 | 1.27s·300; 1.75s·200 |
| S1634.mp4 | S1634 Fuse Delete Wallet Sheet Checkbox Interaction | 60 | 5.8 | 3 | 133 | 0.1s·167; 3.87s·117; 5.35s·133 |
| S1710.mp4 | S1710 Wabi Chat Suggestion Swipe Cards Carousel Interaction | 60 | 12.6 | 9 | 417 | 1.7s·417; 2.43s·750; 3.55s·533; 4.45s·467; 5.15s·367; 6.32s·1650; 8.07s·67; 8.77s·383; 10.28s·367 |
| S1848.mp4 | S1848 Eimi Generating Card Preview Morph Pop Scale in Sheet Animation | 60 | 10.6 | 2 | 800 | 0.13s·717; 9.25s·800 |
| S1861.mp4 | S1861 District Ask AI Intro Sheet Animation | 60 | 11.8 | 8 | 550 | 0.12s·417; 2.35s·183; 2.97s·1983; 5.15s·100; 5.48s·650; 6.35s·550; 7.52s·633; 11.55s·200 |
| S1922.mp4 | S1922 Swiggy Chat Response Loading Animation | 60 | 10.1 | 8 | 117 | 0.03s·383; 1.52s·50; 3.17s·117; 5.07s·50; 5.62s·167; 6.97s·117; 7.52s·117; 8.85s·133 |
| S1945.mp4 | S1945 Avec Hold and Speak Interaction | 60 | 12.1 | 7 | 100 | 3.17s·100; 3.52s·50; 7.17s·150; 7.43s·100; 8.72s·83; 9.12s·133; 9.35s·50 |
| S1977.mp4 | S1977 ChatGPT Intelligence Picker Long Press Slider Interaction | 60 | 4.8 | 8 | 133 | 0.58s·117; 0.98s·217; 1.9s·133; 2.18s·150; 2.58s·150; 3.4s·133; 3.87s·117; 4.35s·50 |
| S1991.mp4 | S1991 Grok Tool Connected Pulse Animation | 15 | 3.3 | 2 | 1200 | 0.07s·467; 1.4s·1200 |
| S2017.mp4 | S2017 Grok App Connected Pulse Animation | 15 | 3.4 | 3 | 400 | 0.13s·400; 1.4s·267; 2.4s·400 |
| S2039.mp4 | S2039 ChatGPT Voice Blob Gradient Interaction | 60 | 7.8 | 5 | 300 | 0.38s·217; 4.2s·150; 4.47s·300; 5.72s·333; 7.25s·300 |
| S2041.mp4 | S2041 Monogram Keyboard Icon Morph to Chat Input Interaction | 60 | 5.8 | 6 | 383 | 0.23s·467; 1.6s·383; 2.38s·383; 3.13s·350; 4.07s·383; 4.82s·350 |
| S2042.mp4 | S2042 Monogram Rich Chat Response Card Swipe Interaction | 60 | 7.5 | 11 | 217 | 0.33s·167; 0.93s·200; 1.68s·300; 2.32s·217; 2.98s·150; 3.57s·117; 4.07s·333; 4.8s·267; 5.4s·283; 5.92s·233; 6.37s·83 |
| S2043.mp4 | S2043 Monogram Pulse Sweep Chat Response Reveal Interaction | 60 | 6.6 | 3 | 700 | 0.38s·700; 2.4s·317; 2.93s·1150 |
| S2047.mp4 | S2047 Monogram Pulse Calendar Connect Reveal Interaction | 60 | 7.8 | 5 | 417 | 0.35s·417; 1.63s·200; 2.53s·183; 5.37s·417; 6.03s·783 |
| S2050.mp4 | S2050 Monogram Tap and Hold Mic Liquid Blur Pulse Interaction | 60 | 17.0 | 11 | 250 | 0.15s·417; 1.4s·450; 3.82s·317; 6.45s·1100; 11.2s·217; 13.38s·233; 13.95s·700; 14.78s·67; 14.98s·117; 16.3s·67; 16.5s·250 |
| S2053.mp4 | S2053 ChatGPT Model Intensity Slider Interaction | 60 | 11.7 | 12 | 300 | 0.68s·367; 2.43s·300; 3.12s·617; 4.15s·67; 4.63s·100; 6.0s·317; 6.72s·317; 7.17s·83; 7.43s·117; 8.58s·400; 9.38s·300; 10.0s·100 |
| S2091.mp4 | S2091 Recollect Pro Bottom Sheet to Page Interaction | 60 | 11.6 | 7 | 500 | 0.27s·667; 2.78s·700; 3.92s·417; 4.88s·383; 5.83s·683; 9.53s·450; 10.32s·500 |
| S2094.mp4 | S2094 Circle Menu Dropdown Morph Interaction | 60 | 6.9 | 10 | 317 | 0.05s·333; 0.98s·233; 1.4s·100; 1.62s·333; 2.47s·217; 3.35s·400; 4.3s·317; 5.0s·233; 5.48s·333; 6.65s·217 |
| S2115.mp4 | S2115 Revolut Single Use Pulse Card Sweep Morph Animation | 60 | 6.1 | 1 | 4583 | 0.3s·4583 |
| S2117.mp4 | S2117 Revolut Feature Buttons Coachmark Border Pulse Interaction | 60 | 15.8 | 11 | 283 | 0.02s·117; 0.25s·283; 0.82s·233; 3.07s·283; 3.63s·433; 6.07s·267; 6.63s·417; 7.5s·50; 9.1s·267; 9.88s·850; 12.12s·300 |
| S2119.mp4 | S2119 Revolut Select Plan Tab Scroll Interaction | 60 | 18.7 | 13 | 533 | 0.13s·317; 1.25s·533; 1.95s·1350; 5.0s·267; 5.97s·650; 7.87s·333; 9.38s·533; 10.23s·1533; 12.42s·283; 13.25s·700; 14.72s·350; 15.92s·533; 16.72s·1367 |
| S2120.mp4 | S2120 Revolut Create Close Pocket Interaction | 60 | 12.2 | 10 | 333 | 0.62s·267; 1.33s·300; 2.35s·450; 3.47s·217; 3.8s·400; 7.1s·333; 8.15s·567; 9.47s·100; 9.85s·333; 10.58s·883 |
| S2123.mp4 | S2123 Circle New Wallet Claim Balance Interaction | 60 | 12.6 | 4 | 650 | 0.02s·650; 4.58s·67; 5.2s·1450; 7.75s·300 |
| S2125.mp4 | S2125 Apple App Store App Page Header Asset Animation | 60 | 5.8 | 0 | None |  |
| S2126.mp4 | S2126 Plasma Duo Style Bottom Sheet Open Interaction | 60 | 13.0 | 8 | 717 | 0.4s·100; 1.13s·567; 2.8s·933; 4.25s·50; 6.0s·1483; 8.27s·717; 10.1s·717; 11.88s·200 |
| S2130.mp4 | S2130 Brick Intro Value Prop Text Flip Interaction | 60 | 8.2 | 2 | 183 | 0.17s·100; 0.98s·183 |
| S2135.mp4 | S2135 Runmo Days Counter Interaction | 60 | 10.0 | 11 | 283 | 0.72s·150; 1.02s·133; 1.63s·450; 2.87s·917; 4.58s·317; 5.02s·550; 6.77s·483; 7.43s·133; 7.87s·217; 8.52s·133; 9.42s·283 |
| S2137.mp4 | S2137 Plasma Card Setup Animation | 60 | 19.7 | 2 | 533 | 11.62s·533; 19.48s·133 |
| sn012-keyboard.mp4 | N012 Keyboard to Input Morph Interaction (snippet) | 25 | 5.0 | 4 | 360 | 0.12s·360; 1.68s·280; 2.56s·1360; 4.16s·280 |
