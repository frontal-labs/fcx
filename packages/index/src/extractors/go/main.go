// Command fcx-go-extract prints the top-level symbols and imports of one Go file as JSON.
//
// Usage: fcx-go-extract <file.go>
//
// It uses go/parser and go/ast from the standard library only. On a parse error it writes
// {"error": "..."} to stderr and exits with status 1. Built by packages/index at runtime and
// cached by the sha256 of this source, so editing this file changes the cache key.
package main

import (
	"encoding/json"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"strconv"
	"strings"
	"unicode/utf8"
)

const (
	maxSignature = 200
	maxDoc       = 400
	maxFileBytes = 2_000_000
)

type symbol struct {
	Name      string `json:"name"`
	Qualified string `json:"qualified"`
	Kind      string `json:"kind"`
	StartLine int    `json:"startLine"`
	EndLine   int    `json:"endLine"`
	Signature string `json:"signature"`
	Doc       string `json:"doc"`
	Exported  bool   `json:"exported"`
}

type output struct {
	Symbols []symbol `json:"symbols"`
	Imports []string `json:"imports"`
}

func fail(message string) {
	_ = json.NewEncoder(os.Stderr).Encode(map[string]string{"error": message})
	os.Exit(1)
}

func main() {
	if len(os.Args) != 2 {
		fail("usage: fcx-go-extract <file.go>")
	}
	path := os.Args[1]
	src, err := os.ReadFile(path)
	if err != nil {
		fail(err.Error())
	}
	if len(src) > maxFileBytes {
		fail("file too large")
	}
	fset := token.NewFileSet()
	file, err := parser.ParseFile(fset, path, src, parser.ParseComments)
	if err != nil {
		fail(err.Error())
	}

	x := &extractor{fset: fset, src: src, out: output{Symbols: []symbol{}, Imports: []string{}}}
	for _, imp := range file.Imports {
		if p, err := strconv.Unquote(imp.Path.Value); err == nil {
			x.out.Imports = append(x.out.Imports, p)
		}
	}
	for _, decl := range file.Decls {
		switch d := decl.(type) {
		case *ast.FuncDecl:
			x.function(d)
		case *ast.GenDecl:
			x.general(d)
		}
	}
	if err := json.NewEncoder(os.Stdout).Encode(x.out); err != nil {
		fail(err.Error())
	}
}

type extractor struct {
	fset *token.FileSet
	src  []byte
	out  output
}

func (x *extractor) text(from, to token.Pos) string {
	start := x.fset.Position(from).Offset
	end := x.fset.Position(to).Offset
	if start < 0 || end > len(x.src) || start > end {
		return ""
	}
	return string(x.src[start:end])
}

func (x *extractor) line(pos token.Pos) int {
	return x.fset.Position(pos).Line
}

func (x *extractor) add(name, qualified, kind string, from, to token.Pos, sig string, doc *ast.CommentGroup, exported bool) {
	x.out.Symbols = append(x.out.Symbols, symbol{
		Name:      name,
		Qualified: qualified,
		Kind:      kind,
		StartLine: x.line(from),
		EndLine:   x.line(to),
		Signature: clip(sig, maxSignature),
		Doc:       docText(doc),
		Exported:  exported,
	})
}

func (x *extractor) function(d *ast.FuncDecl) {
	name := d.Name.Name
	end := d.End()
	sigEnd := d.End()
	if d.Body != nil {
		sigEnd = d.Body.Lbrace
	}
	sig := x.text(d.Pos(), sigEnd)
	if d.Recv == nil {
		x.add(name, name, "function", d.Pos(), end, sig, d.Doc, ast.IsExported(name))
		return
	}
	owner := receiverName(d.Recv)
	if owner == "" {
		return
	}
	x.add(name, owner+"."+name, "method", d.Pos(), end, sig, d.Doc, ast.IsExported(name))
}

func (x *extractor) general(d *ast.GenDecl) {
	single := len(d.Specs) == 1
	for _, spec := range d.Specs {
		switch s := spec.(type) {
		case *ast.TypeSpec:
			kind := "type"
			head := ""
			switch s.Type.(type) {
			case *ast.StructType:
				kind, head = "class", "struct"
			case *ast.InterfaceType:
				kind, head = "interface", "interface"
			default:
				head = x.text(s.Type.Pos(), s.Type.End())
			}
			doc := s.Doc
			if doc == nil && single {
				doc = d.Doc
			}
			sig := "type " + s.Name.Name + " " + head
			x.add(s.Name.Name, s.Name.Name, kind, s.Pos(), s.End(), sig, doc, ast.IsExported(s.Name.Name))
		case *ast.ValueSpec:
			kind := "var"
			if d.Tok == token.CONST {
				kind = "const"
			}
			doc := s.Doc
			if doc == nil && single {
				doc = d.Doc
			}
			sig := x.text(s.Pos(), s.End())
			for _, name := range s.Names {
				if name.Name == "_" {
					continue
				}
				x.add(name.Name, name.Name, kind, s.Pos(), s.End(), sig, doc, ast.IsExported(name.Name))
			}
		}
	}
}

func receiverName(recv *ast.FieldList) string {
	if recv == nil || len(recv.List) == 0 {
		return ""
	}
	expr := recv.List[0].Type
	for {
		switch t := expr.(type) {
		case *ast.StarExpr:
			expr = t.X
		case *ast.ParenExpr:
			expr = t.X
		case *ast.IndexExpr:
			expr = t.X
		case *ast.IndexListExpr:
			expr = t.X
		case *ast.Ident:
			return t.Name
		default:
			return ""
		}
	}
}

func docText(group *ast.CommentGroup) string {
	if group == nil {
		return ""
	}
	return clip(strings.TrimSpace(group.Text()), maxDoc)
}

// clip collapses whitespace and cuts to at most limit bytes on a UTF-8 boundary.
func clip(text string, limit int) string {
	collapsed := strings.Join(strings.Fields(text), " ")
	if len(collapsed) <= limit {
		return collapsed
	}
	cut := collapsed[:limit]
	for !utf8.ValidString(cut) && len(cut) > 0 {
		cut = cut[:len(cut)-1]
	}
	return cut
}
