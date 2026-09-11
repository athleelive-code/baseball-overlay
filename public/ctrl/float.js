// コントローラーを「常に手前」の小窓（スマホ大）で開く部品。コントローラー（float.html）と
// メンバー管理の両方から使う。
// - Chrome / Edge は Document Picture-in-Picture（ほかのアプリの上に浮いたまま）
// - 使えないブラウザは、スマホ大の別ウインドウ（float.html?frame=1）
// 小窓の中身はコントローラーそのもの（iframe）。コントローラーは幅 DESIGN_W で見やすく作ってあるので、
// 小窓の幅に合わせて全体を縮めて入れる（一部しか見えない・触れない、を防ぐ）。
// 小窓を広げれば、そのぶん大きく表示される。
(function(){
  var DESIGN_W = 880;   // 上部のボタン列まで全部が収まる幅
  var W = 430;          // 開いたときの小窓の幅（スマホぐらい）
  var CTRL_URL  = new URL('./', (document.currentScript && document.currentScript.src) || location.href).href;
  var FRAME_URL = CTRL_URL + 'float.html?frame=1';
  function winH(){ return Math.max(600, Math.min(900, (screen.availHeight || 900) - 80)); }

  // win（小窓）の中に、コントローラーを縮めて入れる
  function mount(win){
    var d = win.document;
    d.title = 'AthleeLive コントローラー';
    d.body.style.cssText = 'margin:0;background:#111;overflow:hidden';
    var f = d.createElement('iframe');
    f.src = CTRL_URL;
    f.allow = 'autoplay; clipboard-write; screen-wake-lock';
    f.style.cssText = 'border:0;display:block;position:absolute;left:0;top:0;transform-origin:0 0';
    d.body.appendChild(f);
    function fit(){
      var s = Math.max(0.2, win.innerWidth / DESIGN_W);
      f.style.width  = DESIGN_W + 'px';
      f.style.height = Math.ceil(win.innerHeight / s) + 'px';
      f.style.transform = 'scale(' + s + ')';
    }
    fit();
    win.addEventListener('resize', fit);
    return f;
  }

  var pip = null, pop = null, popTimer = null;
  // 開けた方法を返す：'pip'（常に手前）/ 'popup'（別ウインドウ）/ ''（開けなかった）
  async function open(onClose){
    if('documentPictureInPicture' in window){
      try{
        pip = await documentPictureInPicture.requestWindow({ width:W, height:winH() });
        mount(pip);
        pip.addEventListener('pagehide', function(){ pip = null; if(onClose) onClose(); });
        return 'pip';
      }catch(e){ pip = null; }
    }
    pop = window.open(FRAME_URL, 'athleeCtrlFloat', 'popup,width=' + W + ',height=' + winH());
    if(!pop) return '';
    if(popTimer) clearInterval(popTimer);
    popTimer = setInterval(function(){
      if(!pop || pop.closed){ clearInterval(popTimer); popTimer = null; pop = null; if(onClose) onClose(); }
    }, 1000);
    return 'popup';
  }
  function close(){
    if(pip){ try{ pip.close(); }catch(e){} pip = null; }
    if(pop && !pop.closed){ try{ pop.close(); }catch(e){} }
    pop = null;
  }
  function isOpen(){ return !!pip || !!(pop && !pop.closed); }

  window.AthleeFloat = { open:open, close:close, isOpen:isOpen, mount:mount, CTRL_URL:CTRL_URL,
                         canPip:('documentPictureInPicture' in window) };
})();
