"""OpenGame README diagrams. Reuses the original README SVG authoring approach.
Run from any directory: python3 docs/readme/opengame/diagrams/generate.py
Geometry is SVG; technical meaning follows docs/opengame-architecture.md.
"""
from pathlib import Path
from html import escape
import json
OUT=Path(__file__).parent
LANGS={
'en':{
'flow_title':'From a game idea to a game business','flow_sub':'One creation loop. Your agent, your source, your release.','inputs':['Your idea or reference','100+ viral game resources','Your agent + media models'],'input_sub':['A mechanic, world or audience','Study the loop. Make it yours.','29 agents · image, video and audio'],'steps':['Understand','Remix & build','Create assets','Play & refine','Publish'],'step_sub':['Core loop + audience','Editable game source','Art, music and voice','Rules, input and feel','Web + target platforms'],'flow_end':'Keep the playable game, editable source and launch material.',
'context_title':'A game project that your agent can continue','context_sub':'Creative decisions, assets and evidence stay with the source.','context_names':['Game plan','Asset inventory','Verification','Playable source'],'context_lines':[['design/plan.md','Rules, style and acceptance'],['design/assets.csv','Sources, licenses and costs'],['design/verification.md','Checks, results and gaps'],['HTML · CSS · JavaScript','Controls, levels and game state']],'context_end':'Return to the same project. Remix, review and improve.',
'runtime_title':'One game workspace, shared by Studio and agents','runtime_sub':'Source-checkout architecture · shared local services and game files','agent':'Your coding agent','agent_sub':'Local runtime adapters / external MCP','studio':'Game Studio','studio_sub':'Create · Preview · Code · Share','mcp':'12 game tools / stdio MCP','http':'Local HTTP + agent handoff','service':'Shared local application','service_sub':'Node.js + TypeScript · GameProjects · project lifecycle','gateway':'Model Gateway','gateway_sub':'Catalogs · jobs · provider adapters','project':'Owned game project','project_sub':'HTML / CSS / JS + assets + game.json','verify':'Validate & play-test','verify_sub':'Rule simulation + isolated Chrome','assets':'Reusable media assets','evidence':'Checks + screenshots','output':'Local play · Web snapshot · Gameplay trailer','output_sub':'Same source project; separate publish and export actions','runtime_note':'TikTok / WeChat / Douyin release integrations are product delivery paths, not local MCP game-publish actions.'},
'zh-CN':{
'flow_title':'从一个游戏创意，到自己的游戏生意','flow_sub':'用同一套流程，连接 Agent、源码与发行。','inputs':['你的创意或参考','100+ 热门游戏资源','你的 Agent 与媒体模型'],'input_sub':['玩法、世界观与目标玩家','研究核心循环，做出自己的版本','29 个 Agent · 图像、视频与音频'],'steps':['理解玩法','复刻与实现','生成素材','试玩与打磨','发行游戏'],'step_sub':['核心循环与受众','可编辑游戏源码','美术、音乐与语音','规则、操作与手感','网页与目标平台'],'flow_end':'保留可玩的游戏、可编辑源码和发行素材。',
'context_title':'让 Agent 能持续接手的游戏项目','context_sub':'创作决策、素材与验证记录，和源码保存在一起。','context_names':['游戏方案','素材清单','验证记录','可玩源码'],'context_lines':[['design/plan.md','规则、风格与验收条件'],['design/assets.csv','来源、许可与成本'],['design/verification.md','检查、结果与待验证项'],['HTML · CSS · JavaScript','操作、关卡与游戏状态']],'context_end':'回到同一个项目，继续复刻、审阅与改进。',
'runtime_title':'Studio 与 Agent，共用一个游戏工作区','runtime_sub':'源码版运行架构 · 共享本地服务与游戏文件','agent':'你的编程 Agent','agent_sub':'本地运行时适配 / 外部 MCP','studio':'Game Studio','studio_sub':'创作 · 预览 · 源码 · 分享','mcp':'12 个游戏工具 / stdio MCP','http':'本地 HTTP 与 Agent 任务交接','service':'共享本地应用服务','service_sub':'Node.js + TypeScript · GameProjects · 项目状态管理','gateway':'Model Gateway','gateway_sub':'模型目录 · 生成任务 · 服务商适配','project':'自己的游戏项目','project_sub':'HTML / CSS / JS + 素材 + game.json','verify':'验证与自动试玩','verify_sub':'规则模拟 + 独立 Chrome','assets':'可复用的媒体素材','evidence':'验证结果与截图','output':'本地试玩 · 网页快照 · 游戏预告片','output_sub':'共用源码，分别执行发布与导出','runtime_note':'TikTok / 微信 / 抖音发行属于产品交付路径，与本地 MCP 游戏上架操作分开。'},
'ja':{
'flow_title':'ゲームのアイデアから、ゲームビジネスへ','flow_sub':'Agent、ソース、公開をひとつの制作フローでつなぐ。','inputs':['アイデア・参考作品','100+ の人気ゲーム素材','Agent とメディアモデル'],'input_sub':['仕組み、世界観、プレイヤー','コアループを学び、自分の作品へ','29 の Agent · 画像・動画・音声'],'steps':['理解する','Remix・実装','素材を作る','試遊・改善','公開する'],'step_sub':['コアループと対象','編集可能なソース','アート・音楽・声','ルール・操作感','Web・配信先'],'flow_end':'遊べるゲーム、編集可能なソース、告知素材を保持。',
'context_title':'Agent が制作を引き継げるゲームプロジェクト','context_sub':'制作方針、素材、検証記録をソースと一緒に残す。','context_names':['ゲーム企画','素材一覧','検証記録','遊べるソース'],'context_lines':[['design/plan.md','ルール・表現・受け入れ条件'],['design/assets.csv','出典・ライセンス・費用'],['design/verification.md','検証・結果・未確認点'],['HTML · CSS · JavaScript','操作・ステージ・ゲーム状態']],'context_end':'同じプロジェクトで、Remix・レビュー・改善を続ける。',
'runtime_title':'Studio と Agent が共有するゲームワークスペース','runtime_sub':'ソース版の実行構成 · 共通のローカルサービスとファイル','agent':'コーディング Agent','agent_sub':'ローカル実行アダプター / 外部 MCP','studio':'Game Studio','studio_sub':'制作 · プレビュー · コード · 共有','mcp':'12 のゲームツール / stdio MCP','http':'ローカル HTTP と Agent への引継ぎ','service':'共通のローカルアプリケーション','service_sub':'Node.js + TypeScript · GameProjects · 状態管理','gateway':'Model Gateway','gateway_sub':'モデル一覧 · 生成ジョブ · 接続先','project':'自分のゲームプロジェクト','project_sub':'HTML / CSS / JS + 素材 + game.json','verify':'検証と自動試遊','verify_sub':'ルールのシミュレーション + Chrome','assets':'再利用できるメディア素材','evidence':'結果とスクリーンショット','output':'ローカルプレイ · Web 公開 · トレーラー','output_sub':'同じソースから、公開と書き出しを個別に実行','runtime_note':'TikTok / WeChat / Douyin への公開連携は、ローカル MCP のゲーム登録とは別の配信経路。'}
}
class Diagram:
 def __init__(self,title,sub,height):
  self.h=height
  self.parts=[f'<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="{height}" viewBox="0 0 1200 {height}" role="img" aria-labelledby="title desc"><title id="title">{escape(title)}</title><desc id="desc">{escape(sub)}</desc><defs><marker id="arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto"><path d="M1 1L6 4L1 7" fill="none" stroke="#087c62" stroke-width="1.5"/></marker></defs><rect width="1200" height="{height}" rx="14" fill="#fafaf2"/><g font-family="Arial, Helvetica, PingFang SC, Hiragino Sans, Microsoft YaHei, sans-serif" text-anchor="middle">']
  self.text(600,64,title,32,True);self.text(600,99,sub,17)
 def text(self,x,y,s,size=20,bold=False):self.parts.append(f'<text x="{x}" y="{y}" font-size="{size}" font-weight="{700 if bold else 400}" fill="{ "#202322" if bold else "#46615c"}">{escape(s)}</text>')
 def line(self,d,arrow=True):self.parts.append(f'<path d="{d}" fill="none" stroke="#087c62" stroke-width="2"'+(' marker-end="url(#arrow)"' if arrow else '')+'/>')
 def box(self,x,y,w,h,title,lines,accent=False):
  self.parts.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="10" fill="{ "#e4f1e8" if accent else "#fff"}" stroke="#b9d7cc"/>')
  self.text(x+w/2,y+34,title,23,True)
  for i,l in enumerate(lines):self.text(x+w/2,y+65+i*25,l,16)
 def save(self,name,lang):
  self.parts.append('</g></svg>');(OUT/f'{name}{"" if lang=="en" else "."+lang}.svg').write_text('\n'.join(self.parts)+'\n')
def flow(l,lang):
 d=Diagram(l['flow_title'],l['flow_sub'],500)
 for i in range(3):
  x=48+i*376;d.box(x,133,352,94,l['inputs'][i],[l['input_sub'][i]])
  d.line(f'M{x+176} 227V254',False)
 d.line('M138 254H976',False);d.line('M138 254V295')
 for i in range(5):
  x=42+i*231;d.box(x,300,192,92,l['steps'][i],[l['step_sub'][i]],True)
  if i<4:d.line(f'M{x+192} 345h34')
 d.text(600,458,l['flow_end'],22,True);d.save('creation-stack',lang)
def context(l,lang):
 d=Diagram(l['context_title'],l['context_sub'],400)
 for i in range(4):
  x=40+i*290;d.box(x,144,250,120,l['context_names'][i],l['context_lines'][i]);d.line(f'M{x+125} 264V294',False)
 d.line('M165 294H1035',False);d.line('M600 294V320');d.text(600,365,l['context_end'],23,True);d.save('project-context',lang)
def runtime(l,lang):
 d=Diagram(l['runtime_title'],l['runtime_sub'],780)
 d.box(90,132,450,88,l['agent'],[l['agent_sub']]);d.box(660,132,450,88,l['studio'],[l['studio_sub']])
 d.text(315,249,l['mcp'],17);d.text(885,249,l['http'],17)
 d.line('M315 261V285H600',False);d.line('M885 261V285H600',False);d.line('M600 285V309')
 d.box(190,319,820,94,l['service'],[l['service_sub']],True)
 d.line('M600 413V437',False);d.line('M210 437H990',False)
 for x in [210,600,990]:d.line(f'M{x} 437V461')
 d.box(40,471,340,100,l['gateway'],[l['gateway_sub']]);d.box(430,471,340,100,l['project'],[l['project_sub']],True);d.box(820,471,340,100,l['verify'],[l['verify_sub']])
 d.line('M210 571V605H600V571');d.text(320,630,l['assets'],16)
 d.line('M990 571V605H600',False);d.text(900,630,l['evidence'],16)
 d.line('M600 605V653');d.text(600,687,l['output'],27,True);d.text(600,718,l['output_sub'],18);d.text(600,757,l['runtime_note'],14);d.save('runtime-architecture',lang)
for lang,l in LANGS.items():flow(l,lang);context(l,lang);runtime(l,lang)
print('Generated 9 localized OpenGame diagrams.')
