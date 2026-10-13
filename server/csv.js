export function parseCsv(input) {
  const text=String(input||'').replace(/^\uFEFF/,'');
  const firstLine=text.split(/\r?\n/,1)[0]||'';
  const delimiter=(firstLine.match(/;/g)||[]).length>(firstLine.match(/,/g)||[]).length?';':',';
  const rows=[];let row=[],field='',quoted=false;
  for(let i=0;i<text.length;i++){
    const ch=text[i];
    if(ch==='"') {if(quoted&&text[i+1]==='"'){field+='"';i++}else quoted=!quoted;}
    else if(ch===delimiter&&!quoted){row.push(field);field='';}
    else if((ch==='\n'||ch==='\r')&&!quoted){if(ch==='\r'&&text[i+1]==='\n')i++;row.push(field);if(row.some(x=>x.trim()))rows.push(row);row=[];field='';}
    else field+=ch;
  }
  if(quoted)throw new Error('Незакрытая кавычка в CSV');
  row.push(field);if(row.some(x=>x.trim()))rows.push(row);
  return rows;
}
