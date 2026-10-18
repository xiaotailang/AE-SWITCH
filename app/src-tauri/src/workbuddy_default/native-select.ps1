$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$model=$env:AE_WB_MODEL_ID
function Finish([bool]$selected,[string]$status,[string]$message){
 [Console]::WriteLine((@{selected=$selected;status=$status;model=$model;message=$message}|ConvertTo-Json -Compress))
 exit 0
}
try{
 Add-Type -TypeDefinition @'
using System;using System.Collections.Generic;using System.Runtime.InteropServices;using System.Reflection;using System.Text;
public static class AEWorkBuddySelector {
 public class Node {public object Acc;public object Child;public string Name;public string Value;public bool NameReadable;public bool ValueReadable;public int Role;public int State;public int Depth;public int Index;public int ParentIndex;public int SubtreeEnd;}
 public class Tree {public List<Node> Nodes=new List<Node>();public bool Complete=true;}
 public delegate bool Callback(IntPtr h,IntPtr p);
 [DllImport("oleacc.dll")]static extern int AccessibleObjectFromWindow(IntPtr h,uint o,ref Guid g,[MarshalAs(UnmanagedType.Interface)]out object a);
 [DllImport("oleacc.dll")]static extern int AccessibleChildren([MarshalAs(UnmanagedType.Interface)]object a,int s,int count,[Out,MarshalAs(UnmanagedType.LPArray,SizeParamIndex=2)]object[] c,out int n);
 [DllImport("user32.dll")]static extern bool EnumWindows(Callback c,IntPtr p);
 [DllImport("user32.dll")]static extern bool EnumChildWindows(IntPtr h,Callback c,IntPtr p);
 [DllImport("user32.dll")]static extern uint GetWindowThreadProcessId(IntPtr h,out uint p);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)]static extern int GetClassName(IntPtr h,StringBuilder b,int n);
 [DllImport("user32.dll")]static extern bool IsWindowVisible(IntPtr h);
 public static IntPtr[] Renderers(uint pid){var result=new List<IntPtr>();EnumWindows(delegate(IntPtr h,IntPtr p){uint id;GetWindowThreadProcessId(h,out id);var c=new StringBuilder(200);GetClassName(h,c,200);if(id==pid&&c.ToString()=="Chrome_WidgetWin_1"&&IsWindowVisible(h))EnumChildWindows(h,delegate(IntPtr child,IntPtr q){uint cp;GetWindowThreadProcessId(child,out cp);var b=new StringBuilder(200);GetClassName(child,b,200);if(cp==pid&&b.ToString()=="Chrome_RenderWidgetHostHWND"&&IsWindowVisible(child))result.Add(child);return true;},IntPtr.Zero);return true;},IntPtr.Zero);return result.ToArray();}
 static object Get(object a,string prop,object[] args){try{return a.GetType().InvokeMember(prop,BindingFlags.GetProperty,null,a,args);}catch{if(prop=="accValue"||prop=="accName")return null;throw;}}
 static bool ReadText(object a,object id,string property,out string value){try{value=Convert.ToString(a.GetType().InvokeMember(property,BindingFlags.GetProperty,null,a,new object[]{id}))??"";return true;}catch{value="";return false;}}
 public static void Invoke(Node n){n.Acc.GetType().InvokeMember("accDoDefaultAction",BindingFlags.InvokeMethod,null,n.Acc,new object[]{n.Child});}
 public static Tree Read(IntPtr h){var t=new Tree();var g=new Guid("00020400-0000-0000-C000-000000000046");object a;if(AccessibleObjectFromWindow(h,0xfffffffc,ref g,out a)!=0||a==null){t.Complete=false;return t;}Walk(a,0,0,-1,t);return t;}
 static void Walk(object a,object id,int depth,int parent,Tree t){if(depth>32||t.Nodes.Count>=2500){t.Complete=false;return;}int count=0;Node n;try{count=id is int&&(int)id==0?Convert.ToInt32(Get(a,"accChildCount",null)??0):0;string name,value;bool nameReadable=ReadText(a,id,"accName",out name),valueReadable=ReadText(a,id,"accValue",out value);int index=t.Nodes.Count;n=new Node{Acc=a,Child=id,Depth=depth,Index=index,ParentIndex=parent,SubtreeEnd=index+1,Name=name,Value=value,NameReadable=nameReadable,ValueReadable=valueReadable,Role=Convert.ToInt32(Get(a,"accRole",new object[]{id})??0),State=Convert.ToInt32(Get(a,"accState",new object[]{id})??0)};t.Nodes.Add(n);}catch{t.Complete=false;return;}if(count==0)return;if(count<0||count>2500-t.Nodes.Count){t.Complete=false;return;}var children=new object[count];int actual;if(AccessibleChildren(a,0,count,children,out actual)<0||actual!=count){t.Complete=false;return;}foreach(var child in children){if(child==null){t.Complete=false;continue;}if(child is int){object childAcc=null;try{childAcc=Get(a,"accChild",new object[]{child});}catch{}if(childAcc==null)Walk(a,child,depth+1,n.Index,t);else Walk(childAcc,0,depth+1,n.Index,t);}else Walk(child,0,depth+1,n.Index,t);}n.SubtreeEnd=t.Nodes.Count;}
}
'@
 $expectedPid=[uint32]$env:AE_WB_PROCESS_ID
 $expectedStart=[int64]$env:AE_WB_PROCESS_STARTED_MS
 $expectedImage=$env:AE_WB_PROCESS_IMAGE
 $targetName=$env:AE_WB_MODEL_NAME
 function Check-Identity {
  foreach($pair in @(@($env:AE_WB_MODELS_FILE,$env:AE_WB_MODELS_SHA256),@($env:AE_WB_SELECTION_FILE,$env:AE_WB_SELECTION_SHA256))){
   if(-not $pair[0]){throw 'Configuration guard missing'}
   $hash=[Security.Cryptography.SHA256]::Create()
   try{$actual=[BitConverter]::ToString($hash.ComputeHash([IO.File]::ReadAllBytes($pair[0]))).Replace('-','').ToLowerInvariant()}finally{$hash.Dispose()}
   if($actual -ne $pair[1]){throw 'Configuration changed'}
  }
  $process=Get-Process -Id $expectedPid -ErrorAction Stop
  $epoch=[datetime]::SpecifyKind([datetime]'1970-01-01',[DateTimeKind]::Utc)
  $started=[int64][math]::Floor(($process.StartTime.ToUniversalTime()-$epoch).TotalMilliseconds)
  if($process.Path -ine $expectedImage -or $started -ne $expectedStart){throw 'Identity changed'}
  if($script:handle -and @([AEWorkBuddySelector]::Renderers($expectedPid)|Where-Object {$_ -eq $script:handle}).Count -ne 1){throw 'Window changed'}
 }
 function Home-Selector($tree){
  if(-not $tree.Complete){return $null}
  function Empty-Text([string]$value){return ($value -replace '[\uFEFF\u200B\u200C\u200D\u2060]','').Trim()}
  $placeholder='今天帮你做些什么？@ 添加上下文，/调用技能与指令'
  $visible=@($tree.Nodes|Where-Object {($_.State -band 0x18000) -eq 0})
  # The new-task workspace selector is absent from an open conversation.
  if(@($visible|Where-Object {$_.Role -eq 41 -and $_.Name -eq '选择工作空间'}).Count -ne 1){return $null}
  if(@($visible|Where-Object {$_.Role -eq 41 -and $_.Name -in @('文档处理','金融服务','数据分析及可视化','幻灯片','深度研究')}|Select-Object -ExpandProperty Name -Unique).Count -lt 3){return $null}
  $send=@($visible|Where-Object {$_.Role -eq 43 -and $_.Name -in @('发送','Send')})
  if($send.Count -ne 1 -or ($send[0].State -band 1) -eq 0){return $null}
  $edit=@($visible|Where-Object {$_.Role -eq 42})
  if($edit.Count -eq 0){return $null}
  $composers=@($edit|Where-Object {($_.State -band 0x100000) -ne 0})
  if($composers.Count -ne 1){return $null}
  $composer=$composers[0]
  foreach($e in $edit){
   if(-not $e.ValueReadable){return $null}
   $text=Empty-Text $e.Value
   if($text -and ($e -ne $composer -or $text -ne $placeholder)){return $null}
  }
  # A disabled Send button also occurs while attachments are uploading. Inspect
  # the actual composer subtree, including hidden descendants, rather than
  # treating an empty accValue or a missing delete button as proof of no draft.
  if(-not $composer.NameReadable -or (Empty-Text $composer.Name)){return $null}
  if($composer.SubtreeEnd -lt $composer.Index+1 -or $composer.SubtreeEnd -gt $tree.Nodes.Count){return $null}
  # Native clearing can leave a genuinely empty leaf instead of the initial
  # placeholder subtree. Require an exactly empty readable value in this case.
  $emptyLeaf=$composer.SubtreeEnd -eq $composer.Index+1 -and $composer.Value.Length -eq 0
  if($composer.SubtreeEnd -eq $composer.Index+1 -and -not $emptyLeaf){return $null}
  $placeholderCount=0
  $sentinelCount=0
  for($i=$composer.Index+1;$i -lt $composer.SubtreeEnd;$i++){
   $n=$tree.Nodes[$i]
   if(-not $n.NameReadable -or ($n.State -band 0x18000) -ne 0){return $null}
   $text=Empty-Text $n.Name
   if($n.ValueReadable -and (Empty-Text $n.Value)){return $null}
   if($n.Role -eq 41 -and $text -eq $placeholder){$placeholderCount++;continue}
   if($n.Role -notin @(20,41,59) -or $text){return $null}
   if($n.Role -eq 41 -and $n.Name.Contains([string][char]0xFEFF)){$sentinelCount++}
  }
  if(-not $emptyLeaf -and ($placeholderCount -ne 1 -or $sentinelCount -ne 1)){return $null}
  if(@($visible|Where-Object {$_.Name -match '删除附件|移除附件|Remove attachment|删除文件|移除文件'}).Count){return $null}
  $selectors=@($visible|Where-Object {$_.Role -eq 46 -and $_.Name.StartsWith('Select model: ') -and ($_.State -band 1) -eq 0})
  if($selectors.Count -ne 1){return $null}
  # In the native blank form, the attachment area is a sibling of the editor
  # wrapper. Only empty structural nodes are safe outside editor and toolbar.
  if($composer.ParentIndex -lt 0 -or $composer.ParentIndex -ge $composer.Index){return $null}
  $wrapper=$tree.Nodes[$composer.ParentIndex]
  if($wrapper.ParentIndex -lt 0 -or $wrapper.ParentIndex -ge $wrapper.Index){return $null}
  $form=$tree.Nodes[$wrapper.ParentIndex]
  foreach($n in @($wrapper,$form)){
   if($n.Role -ne 20 -or -not $n.NameReadable -or (Empty-Text $n.Name) -or ($n.ValueReadable -and (Empty-Text $n.Value))){return $null}
  }
  function Form-Child($node){
   for($hop=0;$hop -lt 32;$hop++){
    if($node.ParentIndex -eq $form.Index){return $node}
    if($node.ParentIndex -lt $form.Index -or $node.ParentIndex -ge $node.Index){return $null}
    $node=$tree.Nodes[$node.ParentIndex]
   }
   return $null
  }
  $toolbar=Form-Child $send[0]
  $selectorToolbar=Form-Child $selectors[0]
  if(-not $toolbar -or -not $selectorToolbar -or $toolbar.Index -ne $selectorToolbar.Index -or $toolbar.Index -eq $wrapper.Index){return $null}
  if($form.SubtreeEnd -gt $tree.Nodes.Count -or $wrapper.SubtreeEnd -gt $form.SubtreeEnd -or $toolbar.SubtreeEnd -gt $form.SubtreeEnd){return $null}
  for($i=$form.Index+1;$i -lt $form.SubtreeEnd;$i++){
   if($i -ge $composer.Index -and $i -lt $composer.SubtreeEnd){continue}
   if($i -ge $toolbar.Index -and $i -lt $toolbar.SubtreeEnd){continue}
   $n=$tree.Nodes[$i]
   if(-not $n.NameReadable -or $n.Role -notin @(20,23) -or (Empty-Text $n.Name) -or ($n.ValueReadable -and (Empty-Text $n.Value))){return $null}
  }
  return $selectors[0]
 }
 function Model-Option($tree,[string]$name){
  if(-not $tree.Complete){return $null}
  # Names alone cannot distinguish a built-in model from a custom model. The
  # native popup exposes a separate labelled custom group; require that group
  # and a unique matching item even when the selector already shows this name.
  $options=@($tree.Nodes|Where-Object {$_.Role -eq 34 -and $_.NameReadable -and $_.Name -eq $name})
  if($options.Count -ne 1){return $null}
  $option=$options[0]
  # A long popup marks scrolled options OFFSCREEN. Semantic default action can
  # safely select them; hidden and disabled items must still be rejected.
  if(($option.State -band 0x8001) -ne 0 -or $option.ParentIndex -lt 0 -or $option.ParentIndex -ge $option.Index){return $null}
  $group=$tree.Nodes[$option.ParentIndex]
  if($group.Role -ne 20 -or -not $group.NameReadable -or $group.Name -or ($group.State -band 0x8001) -ne 0){return $null}
  $headings=@($tree.Nodes|Where-Object {$_.Role -eq 41 -and $_.NameReadable -and $_.Name -in @('自定义模型','Custom Models')})
  if($headings.Count -ne 1){return $null}
  $heading=$headings[0]
  if(($heading.State -band 0x8001) -ne 0 -or $heading.Index -ge $option.Index -or $heading.ParentIndex -le $group.Index -or $heading.ParentIndex -ge $heading.Index){return $null}
  $header=$tree.Nodes[$heading.ParentIndex]
  if($header.Role -ne 20 -or $header.ParentIndex -ne $group.Index -or $header.SubtreeEnd -gt $option.Index){return $null}
  return $option
 }
 # A freshly launched renderer may exist before its Home controls are ready.
 # Wait for the same safe surface; this never navigates or changes a draft.
 $readyWait=[Diagnostics.Stopwatch]::StartNew()
 $selector=$null
 $handle=$null
 do{
  Check-Identity
  $handles=@([AEWorkBuddySelector]::Renderers($expectedPid))
  if($handles.Count -eq 1){
   $tree=[AEWorkBuddySelector]::Read($handles[0])
   $selector=Home-Selector $tree
   if($selector){$handle=$handles[0];break}
  }
  Start-Sleep -Milliseconds 100
 }while($readyWait.ElapsedMilliseconds -lt 3000)
 if($handles.Count -ne 1){Finish $false 'accessibility_pending' '请从原入口正常退出 WorkBuddy 后由 AE 启动，再在空白新建任务页面应用默认模型。'}
 if(-not $selector){Finish $false 'home_pending' '请打开空白新建任务页面再应用默认模型；正在打开的任务和草稿保持原选择。'}
 $alreadySelected=$selector.Name -eq ('Select model: '+$targetName)
 Check-Identity
 # Re-read immediately before each native action. No coordinates or text injection.
 $tree=[AEWorkBuddySelector]::Read($handle)
 $selector=Home-Selector $tree
 if(-not $selector){Finish $false 'home_pending' 'WorkBuddy 页面已改变，默认模型尚未应用。'}
 $menuPresent=@($tree.Nodes|Where-Object {$_.Role -in @(11,34) -and ($_.State -band 0x18000) -eq 0}).Count -gt 0
 if(-not $menuPresent -and -not (Model-Option $tree $targetName)){
  Check-Identity
  [AEWorkBuddySelector]::Invoke($selector)
 }
 # Background renderers may expose the popup before its custom group/items.
 # Wait within a deadline, rechecking the same blank Home and configuration on
 # every read. No retry may navigate, create a draft, or reopen a changed page.
 $menuWait=[Diagnostics.Stopwatch]::StartNew()
 $option=$null
 do{
  Start-Sleep -Milliseconds 100
  Check-Identity
  $tree=[AEWorkBuddySelector]::Read($handle)
  if(-not (Home-Selector $tree)){Finish $false 'home_pending' 'WorkBuddy 页面已改变，默认模型尚未应用。'}
  $option=Model-Option $tree $targetName
  if($option){break}
 }while($menuWait.ElapsedMilliseconds -lt 2000)
 if(-not $option){Finish $false 'model_pending' '未能唯一识别自定义模型分组中的原生菜单项，请确认模型配置后重试。'}
 Check-Identity
 $tree=[AEWorkBuddySelector]::Read($handle)
 if(-not (Home-Selector $tree)){Finish $false 'home_pending' 'WorkBuddy 页面已改变，默认模型尚未应用。'}
 $option=Model-Option $tree $targetName
 if(-not $option){Finish $false 'model_pending' '模型菜单已改变，请重试。'}
 Check-Identity
 [AEWorkBuddySelector]::Invoke($option)
 for($attempt=0;$attempt -lt 10;$attempt++){
  Start-Sleep -Milliseconds 100
  Check-Identity
  $selector=Home-Selector ([AEWorkBuddySelector]::Read($handle))
  if($selector -and $selector.Name -eq ('Select model: '+$targetName)){
   Check-Identity
   if($alreadySelected){Finish $true 'already_selected' '已通过唯一原生菜单项核对 WorkBuddy 新建任务默认模型；已有会话保持原选择。'}
   Finish $true 'selected' '已通过 WorkBuddy 原生选择器应用新任务默认模型；已有会话保持原选择。'
  }
 }
 Finish $false 'selection_unverified' '原生默认模型选择尚未确认，请在空白新建任务页面重试。'
}catch{
 Finish $false 'accessibility_pending' '原生默认模型选择服务暂不可用，请打开空白新建任务页面重试。'
}
