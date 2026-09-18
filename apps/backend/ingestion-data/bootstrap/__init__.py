"""Identifica os pontos de entrada e a composição do worker de ingestão.

Papel no fluxo:
    Este módulo fica na borda de inicialização: interpreta configuração, seleciona capacidades e
    conecta os casos de uso aos adaptadores concretos.

Garantias e limites:
    Importar o módulo não deve iniciar conexões nem executar efeitos; recursos são criados
    somente para o comando solicitado.
"""
