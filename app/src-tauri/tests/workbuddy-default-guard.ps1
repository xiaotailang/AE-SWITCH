$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest

# Load only the shipping guard and its node types. Executing the helper itself
# would inspect or act on a desktop, so the test never dot-sources that script.
$helper=Join-Path $PSScriptRoot '../src/workbuddy_default/native-select.ps1'
$tokens=$null
$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($helper,[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'The native helper has PowerShell parse errors'}
$types=@($ast.FindAll({param($n) $n -is [Management.Automation.Language.StringConstantExpressionAst] -and $n.Value.Contains('public static class AEWorkBuddySelector')},$true))
$guard=@($ast.FindAll({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Home-Selector'},$true))
$optionGuard=@($ast.FindAll({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Model-Option'},$true))
if($types.Count -ne 1 -or $guard.Count -ne 1 -or $optionGuard.Count -ne 1){throw 'Expected one shipping node type and one of each guard'}
Add-Type -TypeDefinition $types[0].Value
Invoke-Expression $guard[0].Extent.Text
Invoke-Expression $optionGuard[0].Extent.Text

$placeholder='今天帮你做些什么？@ 添加上下文，/调用技能与指令'
function Add-Node($tree,[int]$role,[string]$name='', [int]$parent=-1,[int]$state=0,[string]$value=''){
 $node=[AEWorkBuddySelector+Node]::new()
 $node.Index=$tree.Nodes.Count
 $node.SubtreeEnd=$node.Index+1
 $node.ParentIndex=$parent
 $node.Depth=if($parent -lt 0){0}else{$tree.Nodes[$parent].Depth+1}
 $node.Role=$role
 $node.Name=$name
 $node.Value=$value
 $node.NameReadable=$true
 $node.ValueReadable=$true
 $node.State=$state
 $tree.Nodes.Add($node)
 for($ancestor=$parent;$ancestor -ge 0;$ancestor=$tree.Nodes[$ancestor].ParentIndex){$tree.Nodes[$ancestor].SubtreeEnd=$node.Index+1}
 return $node
}
function New-Home {
 $tree=[AEWorkBuddySelector+Tree]::new()
 $root=Add-Node $tree 20
 $marker=Add-Node $tree 41 '选择工作空间' $root.Index
 $quick=@(foreach($label in @('文档处理','金融服务','数据分析及可视化')){Add-Node $tree 41 $label $root.Index})
 $search=Add-Node $tree 42 '' $root.Index
 $form=Add-Node $tree 20 '' $root.Index
 $attachments=Add-Node $tree 20 '' $form.Index
 $wrapper=Add-Node $tree 20 '' $form.Index
 $composer=Add-Node $tree 42 '' $wrapper.Index 0x100000 ([string][char]0xFEFF+$placeholder+[char]0x200B)
 $block=Add-Node $tree 20 '' $composer.Index
 $sentinel=Add-Node $tree 41 ([string][char]0xFEFF) $block.Index
 $null=Add-Node $tree 59 "`n" $block.Index
 $hint=Add-Node $tree 41 $placeholder $block.Index
 $tooltip=Add-Node $tree 23 '' $wrapper.Index
 $toolbar=Add-Node $tree 20 '' $form.Index
 $selector=Add-Node $tree 46 'Select model: target-model' $toolbar.Index 0 'target-model'
 $send=Add-Node $tree 43 '发送' $toolbar.Index 1
 return @{Tree=$tree;Root=$root;Marker=$marker;Quick=$quick;Search=$search;Form=$form;Attachments=$attachments;Wrapper=$wrapper;Composer=$composer;Block=$block;Sentinel=$sentinel;Hint=$hint;Tooltip=$tooltip;Toolbar=$toolbar;Selector=$selector;Send=$send}
}

$results=[Collections.Generic.List[object]]::new()
function Check([string]$name,[scriptblock]$mutate,[bool]$expected=$false){
 $fixture=New-Home
 & $mutate $fixture
 $actual=Home-Selector $fixture.Tree
 if(($null -ne $actual) -ne $expected){throw "Guard regression failed: $name"}
 if($expected -and -not [object]::ReferenceEquals($actual,$fixture.Selector)){throw "Guard returned a different node: $name"}
 $results.Add(@{name=$name;passed=$true;accepted=($null -ne $actual)})
}
function Clear-ComposerFixture($f){
 $start=$f.Composer.Index+1
 $end=$f.Composer.SubtreeEnd
 $count=$end-$start
 $f.Tree.Nodes.RemoveRange($start,$count)
 foreach($node in $f.Tree.Nodes){
  if($node.Index -ge $end){$node.Index-=$count}
  if($node.ParentIndex -ge $end){$node.ParentIndex-=$count}
  if($node.SubtreeEnd -ge $end){$node.SubtreeEnd-=$count}
 }
 $f.Composer.Value=''
}

Check 'native blank Home placeholder and sentinels' {} $true
Check 'blank accValue still requires native empty subtree' {param($f) $f.Composer.Value=''} $true
Check 'optional structural accValue unsupported' {param($f) $f.Block.ValueReadable=$false} $true
Check 'active conversation has no Home marker' {param($f) $f.Marker.Name='Conversation'}
Check 'ordinary draft despite disabled Send' {param($f) $f.Composer.Value='keep this draft'}
Check 'stale empty accValue with text descendant' {param($f) $f.Composer.Value='';$f.Hint.Name='keep this draft'}
Check 'literal placeholder draft without native sentinel' {param($f) $f.Sentinel.Name=''}
Check 'unreadable composer value fails closed' {param($f) $f.Composer.ValueReadable=$false}
Check 'unreadable secondary editor fails closed' {param($f) $f.Search.ValueReadable=$false}
Check 'secondary editor containing placeholder is a draft' {param($f) $f.Search.Value=$placeholder}
Check 'unreadable descendant name fails closed' {param($f) $f.Block.NameReadable=$false}
Check 'unreadable composer name fails closed' {param($f) $f.Composer.NameReadable=$false}
Check 'image resource in composer with no accessible label' {param($f) $f.Sentinel.Role=40;$f.Sentinel.Name=''}
Check 'link resource in composer' {param($f) $f.Sentinel.Role=30;$f.Sentinel.Name=''}
Check 'attachment outside editor without delete action' {param($f) $f.Attachments.Role=40}
Check 'attachment filename outside editor' {param($f) $f.Attachments.Name='pending-upload.txt'}
Check 'unreadable attachment container' {param($f) $f.Attachments.NameReadable=$false}
Check 'attachment removal action inside toolbar' {param($f) $f.Selector.Name='Remove attachment'}
Check 'hidden draft descendant is not ignored' {param($f) $f.Hint.State=0x8000}
Check 'offscreen placeholder is not ignored' {param($f) $f.Hint.State=0x10000}
Check 'visible editor descendant containing a value' {param($f) $f.Block.Value='pending resource'}
Check 'duplicate model selectors' {param($f) $f.Search.Role=46;$f.Search.Name='Select model: another-model'}
Check 'duplicate focusable composers' {param($f) $f.Search.State=0x100000}
Check 'incomplete accessibility tree' {param($f) $f.Tree.Complete=$false}
Check 'enabled Send is a draft' {param($f) $f.Send.State=0}
Check 'offscreen model selector' {param($f) $f.Selector.State=0x10000}
Check 'offscreen Home marker' {param($f) $f.Marker.State=0x10000}
Check 'duplicate quick labels cannot impersonate Home' {param($f) $f.Quick[1].Name=$f.Quick[0].Name;$f.Quick[2].Name=$f.Quick[0].Name}
Check 'selector and Send in different form regions' {param($f) $f.Selector.ParentIndex=$f.Root.Index}
Check 'unknown composer parent structure' {param($f) $f.Wrapper.Role=40}
Check 'missing composer descendants' {param($f) $f.Composer.SubtreeEnd=$f.Composer.Index+1}
Check 'native cleared Home with exact empty editor leaf' {param($f) Clear-ComposerFixture $f} $true
Check 'cleared editor with unreadable value fails closed' {param($f) Clear-ComposerFixture $f;$f.Composer.ValueReadable=$false}
Check 'whitespace draft leaf is not exact empty' {param($f) Clear-ComposerFixture $f;$f.Composer.Value=' '}
Check 'cleared editor with an external attachment' {param($f) Clear-ComposerFixture $f;$f.Attachments.Role=40}

function New-Menu {
 $f=New-Home
 $popup=Add-Node $f.Tree 11 '' $f.Root.Index
 $builtin=Add-Node $f.Tree 34 'built-in model' $popup.Index
 $group=Add-Node $f.Tree 20 '' $popup.Index
 $header=Add-Node $f.Tree 20 '' $group.Index
 $heading=Add-Node $f.Tree 41 '自定义模型' $header.Index
 $option=Add-Node $f.Tree 34 'target-model' $group.Index 0x210000
 $f.Popup=$popup;$f.Builtin=$builtin;$f.Group=$group;$f.Header=$header;$f.Heading=$heading;$f.Option=$option
 return $f
}
function Check-Menu([string]$name,[scriptblock]$mutate,[bool]$expected=$false){
 $fixture=New-Menu
 & $mutate $fixture
 $actual=Model-Option $fixture.Tree 'target-model'
 if(($null -ne $actual) -ne $expected){throw "Menu guard regression failed: $name"}
 if($expected -and -not [object]::ReferenceEquals($actual,$fixture.Option)){throw "Menu guard returned a different node: $name"}
 $results.Add(@{name=$name;passed=$true;accepted=($null -ne $actual)})
}
Check-Menu 'unique custom group option may be scrolled offscreen' {} $true
Check-Menu 'visible selected custom group option' {param($f) $f.Option.State=0x200002} $true
Check-Menu 'English custom group heading' {param($f) $f.Heading.Name='Custom Models'} $true
Check-Menu 'built-in item with same display name fails uniqueness' {param($f) $f.Builtin.Name='target-model'}
Check-Menu 'built-in item cannot impersonate custom group' {param($f) $f.Option.Name='other-model';$f.Builtin.Name='target-model'}
Check-Menu 'unlabelled custom group fails closed' {param($f) $f.Heading.Name=''}
Check-Menu 'unreadable custom heading fails closed' {param($f) $f.Heading.NameReadable=$false}
Check-Menu 'disabled custom option' {param($f) $f.Option.State=1}
Check-Menu 'hidden custom option' {param($f) $f.Option.State=0x8000}
Check-Menu 'heading from an unrelated group' {param($f) $f.Header.ParentIndex=$f.Popup.Index}
Check-Menu 'incomplete menu traversal' {param($f) $f.Tree.Complete=$false}

@{passed=$true;count=$results.Count;nativeActionsInvoked=$false;cases=$results}|ConvertTo-Json -Depth 5
