---
layout: post
title:  "Internationalisation d’une application JSF"
date:   2013-07-16 00:13:37
categories: articles
img: /images/Internationalisation-JSF/cover.jpg
tags: JSF i18n
desc: Chaque utilisateur qui se connecte sur un site web possède des spécificités qui lui sont propres notamment sa langue. Lors de la connexion d’un visiteur, il est possible de connaître la langue de celui-ci grâce à la variable LANG dans les entêtes de la requête.
---

## Introduction

Chaque utilisateur qui se connecte sur un site web possède des spécificités qui lui sont propres notamment sa langue. Lors de la connexion d’un visiteur, il est possible de connaître la langue de celui-ci grâce à la variable LANG dans les entêtes de la requête.<br/>
<br/>
La langue du visiteur se retrouve codée :<br/>

+ fr_FR pour la France
+ fr_CA pour le Canada
+ en_US pour les USA
+ en_UK pour la Grande Bretagne

En JEE, il existe des mécanismes permettant à une application de s’adapter à la langue du visiteur appelés i18n (il y a 18 lettres entre le i et le n de internationalisation)

##Implémentation de i18n en JSF

Tout d’abord, il est nécessaire de créer les fichiers .properties contenant les messages dans les différentes langues.<br/>
<img src="/images/Internationalisation-JSF/struct.png" />
On nomme en général les fichiers sous la forme « messages`_<LANG>`.properties ».<br/>
Ces fichiers contiennent sur chaque ligne une clé et une valeur. La clé doit être identique pour chaque fichier properties, seul la valeur change en fonction de la langue.<br/>
<br/>
Exemple du fichier message_fr.properties
{% highlight properties %}
label.footer.ajoutersite           = Ajoutez votre site
label.footer.apropos               = A Propos
label.footer.bonsplans             = Bons Plans
label.footer.contact               = Contact
{% endhighlight %}
Une fois les fichiers .properties créés, il est necessaire de modifier le fichier de configuration faces-config.xml.
{% highlight xml %}
<faces-config>
    ....
    <application>
<!-- URL du package contenant les message_XX.properties -->
       <resource-bundle>
             <base-name>fr.toutelinfo.message.message</base-name>
             <var>msg</var>
       </resource-bundle>
<!-- Ajout de la langue par défaut et des langues supportées -->
       <locale-config>
             <default-locale>fr</default-locale>
             <supported-locale>fr</supported-locale>
             <supported-locale>en</supported-locale>
       </locale-config>
   </application>
</faces-config>
{% endhighlight %}
Ensuite le managedBean, celui-ci permet de conserver pendant la durée de la session le choix de la langue du visiteur.
{% highlight java %}
@ManagedBean(name = "localeManagedBean")
@SessionScoped
public class LocaleManagedBean implements Serializable{

    /**
     * La locale courante
     */
    private Locale locale = FacesContext.getCurrentInstance().getViewRoot()
    									.getLocale();

    /**
     * Permet d'obtenir la nom de la locale
     * @return
     */
    public String getLanguage() {
        return locale.getLanguage();
    }

    /**
     * Permet de modifier le language de la page
     * @param language
     */
    public void setLanguage(String language) {
        locale = new Locale(language);
        FacesContext.getCurrentInstance().getViewRoot().setLocale(locale);
    }

    /**
     * Permet d'obtenir la locale courante
     * @return
     */
    public Locale getLocale(){
        return locale;
    }

    /**
     * Permet d'obtenir la liste des langues supportées
     * @return
     */
    public SelectItem[] getLocales() {
        ArrayList items = new ArrayList();
        Application application = FacesContext.getCurrentInstance()
           									  .getApplication();
        Iterator<Locale> supportedLocales = application.getSupportedLocales();

        while (supportedLocales.hasNext()) {
                Locale loc = supportedLocales.next();
                items.add(new SelectItem(loc.getLanguage(),
                						 loc.getDisplayName(locale) );
        }
        SelectItem[] locales = new SelectItem[items.size()];
        items.toArray(locales);
        return locales;
    }

}
{% endhighlight %}
Puis dans le fichier xhtml, on ajoute les messages à afficher ainsi que la langue dans la balise view.
{% highlight xml %}
<?xml version='1.0' encoding='UTF-8' ?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml"
      xmlns:ui="http://java.sun.com/jsf/facelets"
      xmlns:h="http://java.sun.com/jsf/html"
      xmlns:f="http://java.sun.com/jsf/core"
      lang="#{localeManagedBean.language}"
      >
    <f:view locale="#{localeManagedBean.locale}">
        <h:head>
            ....
        </h:head>
        <h:body>
           <h:outputLabel value="#{msg['label.footer.contact']}"/>
           <h:form>
                <h:selectOneMenu value="#{localeManagedBean.language}"  
                	onchange="submit()">
                    <f:selectItems value="#{localeManagedBean.locales}" />
                </h:selectOneMenu>
           </h:form>
        </h:body>
</html>
{% endhighlight %}
Mettre le nom de la langue en attribut de la balise </html> est utile pour la SEO.<br/>
la valeur de outputLabel s’adaptera au choix de la langue du visteur.
